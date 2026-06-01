import { fromBinary, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import * as zlib from "zlib"

import {
  AgentClientMessage,
  AgentClientMessageSchema,
  AgentRunRequest,
  AssistantMessageSchema,
  ConversationStepSchema,
  ConversationStateStructure,
  ConversationTurnStructureSchema,
  type CursorRule,
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientMessageSchema,
  InteractionResponse,
  type RequestedModel_ModelParameterValue,
  UserMessage,
  UserMessageAction,
  UserMessageSchema,
} from "../../../gen/agent/v1_pb"
import { parseModelRequest } from "../../../llm/shared/model-request"
import { normalizeRequestedThinkingEffort } from "../../../llm/shared/thinking-intent"
import { parseCursorVariantString } from "../cursor-model-protocol"
import {
  getDefaultAgentToolNames,
  isCursorBuiltInToolAllowed,
} from "./cursor-tool-mapper"
import {
  getCursorSkillMetadata,
  normalizeSkillName,
  normalizePathForMatch,
} from "../skills"
import { KvStorageService } from "../kv-storage.service"
import { extractWorkspaceFoldersWithPrimary } from "./workspace-folders"
import { CursorProtocolTraceService } from "../cursor-protocol-trace.service"

// GZIP 魔数
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])

// 已解析的 tool 结果
export interface ParsedToolResult {
  toolCallId: string
  toolType: number
  resultCase: string
  resultData: Buffer
  // Optional synthetic result content injected by server-side inline tools.
  inlineContent?: string
  // Optional history payload override for inline tools that need richer
  // function_call_output bodies than plain text, such as view_image.
  inlineHistoryContent?: string | Array<Record<string, unknown>>
  inlineState?: {
    status:
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
    message?: string
  }
  inlineProjection?: {
    taskSuccess?: {
      conversationSteps?: Array<Record<string, unknown>>
      agentId?: string
      isBackground?: boolean
      durationMs?: bigint | number
      resultSuffix?: string
      transcriptPath?: string
    }
    askQuestionResult?: {
      resultCase: "success" | "async" | "rejected" | "error"
      answers?: Array<{
        questionId?: string
        selectedOptionIds?: string[]
        freeformText?: string
      }>
      reason?: string
      errorMessage?: string
    }
    webSearchResult?: {
      query?: string
      references?: Array<{
        title?: string
        url?: string
        chunk?: string
      }>
    }
    webFetchResult?: {
      url?: string
      title?: string
      contentType?: string
      markdown?: string
    }
  }
  inlineExtraData?: {
    beforeContent?: string
    afterContent?: string
    editSuccess?: {
      linesAdded?: number
      linesRemoved?: number
      diffString?: string
      message?: string
    }
    shellResult?: {
      stdout?: string
      stderr?: string
      exitCode?: number
      shellId?: number
      pid?: number
      msToWait?: number
      terminalsFolder?: string
      backgroundReason?: number
      isBackground?: boolean
      aborted?: boolean
    }
    writeShellStdinSuccess?: {
      shellId?: number
      terminalFileLengthBeforeInputWritten?: number
    }
    generateImageSuccess?: {
      filePath?: string
      imageData?: string
    }
  }
}

// MCP 工具定义（从 Cursor 协议 McpToolDefinition 解析）
export interface McpToolDef {
  /** 完整工具名（含 server 前缀），如 "user-Context7-resolve-library-id" */
  name: string
  /** MCP 工具的原始名称，如 "resolve-library-id" */
  toolName: string
  /** MCP server 标识，如 "user-Context7" */
  providerIdentifier: string
  /** 工具描述 */
  description: string
  /** JSON Schema 形式的 input_schema */
  inputSchema?: Record<string, unknown>
  /**
   * IDE-side MCP server registry key — the value the Cursor IDE actually
   * uses to look up the server when bridge forwards `serverName` /
   * `provider_identifier` on `ListMcpResourcesExecArgs`,
   * `ReadMcpResourceExecArgs`, or `McpArgs`.
   *
   * Background: in current Cursor builds, the wire-level
   * `McpToolDefinition.provider_identifier` is the short alias the user
   * typed (e.g. `context7`), but the IDE's MCP registry keys servers
   * with the prefixed form (e.g. `user-context7`). Forwarding the short
   * alias verbatim makes the IDE answer
   * `Server "context7" not found` even though the channel is healthy.
   *
   * Computed once here (`computeMcpIdeRegistryKey`) at parse time, then
   * read by `resolveMountedMcpServer` at dispatch time. Empty string
   * means "no usable key" (caller falls back to `providerIdentifier`).
   *
   * NOTE: when Cursor fixes the wire-level mismatch (i.e. ships a
   * `McpToolDefinition.provider_identifier` that already equals the IDE
   * registry key), this field will simply collapse onto
   * `providerIdentifier` and the resolver becomes an identity function.
   */
  ideRegistryKey: string
}

/**
 * Compute the canonical IDE-side MCP server registry key for a given
 * tool definition. See `McpToolDef.ideRegistryKey` for background.
 *
 * Derivation (in order):
 *   1. If `name` ends with `-${toolName}`, the prefix is the IDE
 *      registry key (e.g. `user-context7-resolve-library-id` minus
 *      `-resolve-library-id` → `user-context7`).
 *   2. Otherwise fall back to `providerIdentifier`. This handles tool
 *      definitions that arrived without a composed `name` (some
 *      protocol variants only carry `toolName` + `providerIdentifier`),
 *      and the future-proof case where Cursor stops mangling the
 *      wire-level identifier.
 *   3. If neither yields a non-empty value, return `""`. Callers must
 *      treat that as "no candidate" and fall through.
 */
export function computeMcpIdeRegistryKey(input: {
  name?: string | null
  toolName?: string | null
  providerIdentifier?: string | null
}): string {
  const name = (input.name || "").trim()
  const toolName = (input.toolName || "").trim()
  const provider = (input.providerIdentifier || "").trim()

  if (name && toolName) {
    const suffix = `-${toolName}`
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length)
    }
  }
  return provider
}

// Cursor 协议中附加的图片数据（从 SelectedImage 解析）
export interface AttachedImage {
  /** Base64 encoded image data */
  data: string
  /** MIME type, e.g. "image/png" */
  mimeType: string
  /** Optional dimensions */
  width?: number
  height?: number
}

// 已解析的请求结构（保持与旧版相同的接口约定）
export interface ParsedCursorRequest {
  // 对话历史
  conversation: Array<{
    role: "user" | "assistant"
    content: string
  }>

  // 新消息
  newMessage: string

  // 模型信息
  model: string
  thinkingLevel: number
  thinkingDetailsRequested?: boolean

  // 模式和能力
  unifiedMode: "CHAT" | "AGENT" | "EDIT" | "CUSTOM"
  isAgentic: boolean

  // 上下文
  supportedTools: string[]
  useWeb: boolean

  // 会话跟踪
  conversationId?: string
  bubbleId?: string

  // 项目上下文
  projectContext?: {
    rootPath: string
    directories: string[]
    files: string[]
    /**
     * Multi-root workspace folders synced from the IDE.
     *
     * Cursor 协议层有三个数据源都会带 multi-root workspace 信息，按
     * 完整度从高到低：
     *   1. `StreamUnifiedChatRequest.workspace_folders` (field 81)
     *      → `repeated WorkspaceFolder { uri, name }`，优先级最高（带显示名）
     *   2. `ConversationMessage.workspace_uris` (field 87)
     *      → `repeated string` (file:// URIs)
     *   3. `ConversationMessage.workspace_project_dir` (field 84)
     *      → `optional string`（单个主项目目录）
     *
     * 我们 parser 内部把三处统一成下面这个数组形状，让上层代码只
     * 跟一个字段打交道。`uri` 保留协议原文（含 file:// 前缀），
     * `path` 是解析后的本地绝对路径，`name` 优先取 IDE 显示名，
     * 缺失时落到目录尾段。
     *
     * 当 IDE 是单 root 工作区时，这里通常只会有一个条目且和
     * `rootPath` 重合 — 这是预期行为，去重交给 session 层 +
     * isPathWithinAllowedRoots 处理（依赖路径归一化）。
     *
     * Optional 是为了兼容老的持久化 session（JSON on disk 里没有
     * 这个字段时 load 后是 undefined），所有消费方都要能 fallback
     * 到 `[{ path: rootPath, ... }]`。
     */
    workspaceFolders?: Array<{
      uri: string
      path: string
      name: string
    }>
  }

  // 附加代码块
  codeChunks?: Array<{
    path: string
    content: string
    startLine?: number
    endLine?: number
  }>

  // Cursor 规则（保留协议原始结构，避免在解析阶段丢失元数据）
  cursorRules?: CursorRule[]
  selectedCursorRulePaths?: string[]
  selectedCursorRuleNames?: string[]

  // Cursor Commands (/ 命令 — 用户定义的可复用工作流)
  cursorCommands?: Array<{ name: string; content: string }>

  // 自定义 system prompt（来自 AgentRunRequest.customSystemPrompt）
  customSystemPrompt?: string

  // 协议中的 token 预算（用于严格跟随 Cursor 参数）
  contextTokenLimit?: number
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>

  // 显式上下文
  explicitContext?: string

  // RequestContext.env 中的运行时目录/环境元数据
  requestContextEnv?: {
    terminalsFolder?: string
    projectFolder?: string
    shell?: string
    timeZone?: string
    agentTranscriptsFolder?: string
    artifactsFolder?: string
  }

  // 附加图片（从 selectedContext.selectedImages 解析）
  attachedImages?: AttachedImage[]

  // 客户端 Tool 结果
  toolResults?: ParsedToolResult[]

  // Agent 控制消息
  isAgentControlMessage?: boolean
  agentControlType?:
    | "heartbeat"
    | "streamClose"
    | "execHeartbeat"
    | "execStreamClose"
    | "execThrow"
    | "cancelAction"
    | "prewarm"
    // ConversationAction 补齐
    | "summarizeAction"
    | "shellCommandAction"
    | "startPlanAction"
    | "executePlanAction"
    | "asyncAskQuestionCompletionAction"
    | "cancelSubagentAction"
    | "backgroundTaskCompletionAction"
    | "backgroundShellAction"
    | "backgroundSubagentAction"
    | "other"
  agentControlExecId?: number
  agentControlError?: string
  agentControlStackTrace?: string
  // ConversationAction 补齐：额外字段
  agentControlSubagentId?: string
  agentControlToolCallId?: string
  agentControlShellCommand?: { command: string; execId: string }
  agentControlTriggeringAuthId?: string
  agentControlTriggeringUserId?: number
  // ConversationAction.asyncAskQuestionCompletionAction 详细 payload。
  // 当 IDE 用户回答了一个 run_async=true 的 ask_question 后，这里
  // 携带原始问题（用于在历史中渲染）和用户答复（结构化的 oneof）。
  agentControlAsyncAskCompletion?: {
    originalToolCallId: string
    originalQuestionText?: string
    resultCase: "success" | "rejected" | "error" | "async" | "unknown"
    answers?: Array<{
      questionId: string
      selectedOptionIds: string[]
      freeformText?: string
    }>
    rejectedReason?: string
    errorMessage?: string
  }
  agentControlBackgroundTaskCompletions?: Array<{
    taskId: string
    kind?: number
    status?: number
    title?: string
    detail?: string
    outputPath?: string
    threadId?: string
    reason?: number
  }>

  // InteractionQuery 响应（客户端回复服务器查询）
  interactionResponse?: {
    id: number
    resultCase: string
    approved: boolean
    rawResponse: InteractionResponse
  }

  // ConversationAction.resume_action
  isResumeAction?: boolean
  resumePendingToolCallIds?: string[]
  statePendingToolCallIds?: string[]

  // MCP 工具定义（从 Cursor 协议 McpToolDefinition 解析，含完整 input_schema）
  mcpToolDefs?: McpToolDef[]
}

/**
 * Agent 模式 ExecClientMessage 中 oneof 的字段名映射
 */
const EXEC_RESULT_CASE_MAP: Record<string, string> = {
  shellResult: "shell_result",
  writeResult: "write_result",
  deleteResult: "delete_result",
  grepResult: "grep_result",
  readResult: "read_result",
  lsResult: "ls_result",
  diagnosticsResult: "diagnostics_result",
  requestContextResult: "request_context_result",
  mcpResult: "mcp_result",
  shellStream: "shell_stream",
  backgroundShellSpawnResult: "background_shell_spawn_result",
  listMcpResourcesExecResult: "list_mcp_resources_exec_result",
  readMcpResourceExecResult: "read_mcp_resource_exec_result",
  fetchResult: "fetch_result",
  recordScreenResult: "record_screen_result",
  computerUseResult: "computer_use_result",
  writeShellStdinResult: "write_shell_stdin_result",
  executeHookResult: "execute_hook_result",
  // ExecClientMessage 补齐
  subagentResult: "subagent_result",
  redactedReadResult: "redacted_read_result",
  forceBackgroundShellResult: "force_background_shell_result",
  forceBackgroundSubagentResult: "force_background_subagent_result",
  canvasGetUrlResult: "canvas_get_url_result",
  canvasDestroyResult: "canvas_destroy_result",
  canvasRegisterResult: "canvas_register_result",
  mcpStateExecResult: "mcp_state_exec_result",
  subagentAwaitResult: "subagent_await_result",
}

type ParsedBackgroundTaskCompletion = NonNullable<
  ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
>[number]

type ParsedAsyncAskCompletion = NonNullable<
  ParsedCursorRequest["agentControlAsyncAskCompletion"]
>

function normalizeBackgroundTaskCompletions(
  raw: unknown
): ParsedBackgroundTaskCompletion[] {
  if (!Array.isArray(raw)) return []

  const maybeNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  const maybeString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined

  const completions: ParsedBackgroundTaskCompletion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const taskId = maybeString(record.taskId)
    if (!taskId) continue
    completions.push({
      taskId,
      kind: maybeNumber(record.kind),
      status: maybeNumber(record.status),
      title: maybeString(record.title),
      detail: maybeString(record.detail),
      outputPath: maybeString(record.outputPath),
      threadId: maybeString(record.threadId),
      reason: maybeNumber(record.reason),
    })
  }
  return completions
}

function summarizeBackgroundTaskCompletionsForLog(
  completions: ParsedBackgroundTaskCompletion[]
): string {
  const rendered = completions
    .map((completion) => {
      const fields = [
        `taskId=${completion.taskId}`,
        completion.kind !== undefined ? `kind=${completion.kind}` : "",
        completion.status !== undefined ? `status=${completion.status}` : "",
        completion.reason !== undefined ? `reason=${completion.reason}` : "",
        completion.title ? `title=${completion.title}` : "",
        completion.detail ? `detail=${completion.detail}` : "",
        completion.outputPath ? `outputPath=${completion.outputPath}` : "",
        completion.threadId ? `threadId=${completion.threadId}` : "",
      ].filter(Boolean)
      return `{${fields.join(", ")}}`
    })
    .join("; ")
  return rendered.length > 800 ? `${rendered.slice(0, 800)}…` : rendered
}

function normalizeAsyncAskQuestionCompletionAction(
  raw: unknown
): ParsedAsyncAskCompletion | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const asyncAction = raw as {
    originalToolCallId?: string
    originalArgs?: {
      questions?: Array<{
        id?: string
        prompt?: string
        question?: string
        text?: string
      }>
      title?: string
    }
    result?: {
      result?: {
        case?: string
        value?: unknown
      }
    }
  }

  const originalQuestionText = (() => {
    const args = asyncAction.originalArgs
    if (!args) return undefined
    const parts: string[] = []
    if (args.title) parts.push(args.title)
    if (Array.isArray(args.questions)) {
      for (const q of args.questions) {
        const text = q.prompt || q.question || q.text || ""
        if (text) parts.push(text)
      }
    }
    const joined = parts.join(" / ").trim()
    return joined || undefined
  })()

  const innerResult = asyncAction.result?.result
  const innerCase = innerResult?.case
  let resultCase: ParsedAsyncAskCompletion["resultCase"] = "unknown"
  let answers: ParsedAsyncAskCompletion["answers"]
  let rejectedReason: string | undefined
  let errorMessage: string | undefined

  if (innerCase === "success") {
    resultCase = "success"
    const successValue = innerResult?.value as
      | {
          answers?: Array<{
            questionId?: string
            selectedOptionIds?: string[]
            freeformText?: string
          }>
        }
      | undefined
    if (Array.isArray(successValue?.answers)) {
      answers = successValue.answers.map((a) => ({
        questionId: a?.questionId || "",
        selectedOptionIds: Array.isArray(a?.selectedOptionIds)
          ? a.selectedOptionIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        freeformText:
          typeof a?.freeformText === "string" && a.freeformText.length > 0
            ? a.freeformText
            : undefined,
      }))
    }
  } else if (innerCase === "rejected") {
    resultCase = "rejected"
    const rejectedValue = innerResult?.value as { reason?: string } | undefined
    rejectedReason =
      typeof rejectedValue?.reason === "string"
        ? rejectedValue.reason
        : undefined
  } else if (innerCase === "error") {
    resultCase = "error"
    const errorValue = innerResult?.value as
      | { errorMessage?: string }
      | undefined
    errorMessage =
      typeof errorValue?.errorMessage === "string"
        ? errorValue.errorMessage
        : undefined
  } else if (innerCase === "async") {
    resultCase = "async"
  }

  return {
    originalToolCallId: asyncAction.originalToolCallId || "",
    originalQuestionText,
    resultCase,
    answers,
    rejectedReason,
    errorMessage,
  }
}

/**
 * 创建空控制消息的辅助函数
 */
function makeControlMessage(
  agentControlType:
    | "heartbeat"
    | "streamClose"
    | "execHeartbeat"
    | "execStreamClose"
    | "execThrow"
    | "cancelAction"
    | "prewarm"
    // ConversationAction 补齐
    | "summarizeAction"
    | "shellCommandAction"
    | "startPlanAction"
    | "executePlanAction"
    | "asyncAskQuestionCompletionAction"
    | "cancelSubagentAction"
    | "backgroundTaskCompletionAction"
    | "backgroundShellAction"
    | "backgroundSubagentAction"
    | "other",
  options?: {
    conversationId?: string
    model?: string
    execId?: number
    error?: string
    stackTrace?: string
    subagentId?: string
    toolCallId?: string
    shellCommand?: { command: string; execId: string }
    triggeringAuthId?: string
    triggeringUserId?: number
    asyncAskCompletion?: ParsedCursorRequest["agentControlAsyncAskCompletion"]
    backgroundTaskCompletions?: ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
  }
): ParsedCursorRequest {
  return {
    conversation: [],
    newMessage: "",
    model: options?.model || "",
    thinkingLevel: 0,
    unifiedMode: "AGENT",
    isAgentic: true,
    supportedTools: [],
    useWeb: false,
    conversationId: options?.conversationId,
    isAgentControlMessage: true,
    agentControlType,
    agentControlExecId: options?.execId,
    agentControlError: options?.error,
    agentControlStackTrace: options?.stackTrace,
    agentControlSubagentId: options?.subagentId,
    agentControlToolCallId: options?.toolCallId,
    agentControlShellCommand: options?.shellCommand,
    agentControlTriggeringAuthId: options?.triggeringAuthId,
    agentControlTriggeringUserId: options?.triggeringUserId,
    agentControlAsyncAskCompletion: options?.asyncAskCompletion,
    agentControlBackgroundTaskCompletions: options?.backgroundTaskCompletions,
  }
}

export class CursorRequestParser {
  private readonly logger = new Logger(CursorRequestParser.name)

  private readonly textDecoder = new TextDecoder()
  private readonly normalStateContextTokenLimitCeiling = 250_000

  constructor(
    private readonly kvStorageService: KvStorageService = new KvStorageService()
  ) {}

  private decodeBlobId(blobId: Uint8Array): string {
    return this.textDecoder.decode(blobId)
  }

  private getStoredBlobBytes(blobId: string): Buffer | null {
    if (!blobId) return null
    const blobData = this.kvStorageService.getBlob(blobId)
    if (!blobData) return null

    try {
      return Buffer.from(blobData, "base64")
    } catch {
      return null
    }
  }

  private resolveStoredBlobBytes(blobIdBytes?: Uint8Array): Buffer | null {
    if (!blobIdBytes || blobIdBytes.length === 0) return null
    const blobId = this.decodeBlobId(blobIdBytes)
    return this.getStoredBlobBytes(blobId)
  }

  private resolveProtocolReferenceBytes(ref?: Uint8Array): Buffer | null {
    if (!ref || ref.length === 0) return null
    return this.resolveStoredBlobBytes(ref) || Buffer.from(ref)
  }

  private extractTextFromStructuredPayload(payload: string): string {
    if (!payload) return ""

    try {
      const parsed = JSON.parse(payload) as unknown
      if (typeof parsed === "string") return parsed

      if (parsed && typeof parsed === "object") {
        const direct = parsed as Record<string, unknown>
        for (const key of ["text", "content", "query", "message"]) {
          const value = direct[key]
          if (typeof value === "string" && value.trim()) {
            return value
          }
        }
      }

      const parts: string[] = []
      const visit = (value: unknown, depth: number) => {
        if (depth > 8 || value == null) return
        if (typeof value === "string") return
        if (Array.isArray(value)) {
          for (const item of value) visit(item, depth + 1)
          return
        }
        if (typeof value !== "object") return

        const record = value as Record<string, unknown>
        if (typeof record.text === "string" && record.text.trim()) {
          parts.push(record.text)
        }
        for (const nested of Object.values(record)) {
          visit(nested, depth + 1)
        }
      }
      visit(parsed, 0)

      const joined = parts.join("").trim()
      return joined || payload
    } catch {
      return payload
    }
  }

  private decodeStoredTextBlob(blobIdBytes?: Uint8Array): string {
    const bytes = this.resolveStoredBlobBytes(blobIdBytes)
    if (!bytes || bytes.length === 0) return ""

    return this.extractTextFromStructuredPayload(bytes.toString("utf8"))
  }

  private extractUserMessagePrompt(userMsg?: UserMessage): string {
    if (!userMsg) return ""

    if (userMsg.text?.trim()) {
      return userMsg.text
    }

    const textBlob = this.decodeStoredTextBlob(userMsg.textBlobId)
    if (textBlob.trim()) {
      return textBlob
    }

    const richTextBlob = this.decodeStoredTextBlob(userMsg.richTextBlobId)
    if (richTextBlob.trim()) {
      return richTextBlob
    }

    return ""
  }

  private extractAttachedImagesFromUserMessage(
    userMsg?: UserMessage
  ): AttachedImage[] {
    const attachedImages: AttachedImage[] = []
    if (!userMsg?.selectedContext?.selectedImages?.length) {
      return attachedImages
    }

    for (const img of userMsg.selectedContext.selectedImages) {
      const mimeType = img.mimeType || "image/png"
      let base64Data: string | undefined

      switch (img.dataOrBlobId.case) {
        case "data":
          base64Data = Buffer.from(img.dataOrBlobId.value).toString("base64")
          break
        case "blobIdWithData": {
          const blobId = this.decodeBlobId(img.dataOrBlobId.value.blobId)
          base64Data = Buffer.from(img.dataOrBlobId.value.data).toString(
            "base64"
          )
          if (blobId) {
            this.kvStorageService.storeBlob(blobId, base64Data)
          }
          break
        }
        case "blobId": {
          const blobId = this.decodeBlobId(img.dataOrBlobId.value)
          base64Data = this.kvStorageService.getBlob(blobId)
          if (!base64Data) {
            this.logger.error(
              `Image blob not found for selected image (uuid=${img.uuid}, blobId=${blobId})`
            )
          }
          break
        }
      }

      if (base64Data) {
        attachedImages.push({
          data: base64Data,
          mimeType,
          width: img.dimension?.width,
          height: img.dimension?.height,
        })
      }
    }

    if (attachedImages.length > 0) {
      this.logger.log(
        `Extracted ${attachedImages.length} image(s) from selectedContext (total ${attachedImages.reduce((sum, img) => sum + img.data.length, 0)} base64 chars)`
      )
    }

    return attachedImages
  }

  /**
   * Convert a protobuf google.protobuf.Value to plain JS value.
   */
  private protoValueToJs(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    const v = value as { kind?: { case?: string; value?: unknown } }
    if (!v.kind || !v.kind.case) return undefined
    switch (v.kind.case) {
      case "nullValue":
        return null
      case "numberValue":
        return v.kind.value
      case "stringValue":
        return v.kind.value
      case "boolValue":
        return v.kind.value
      case "structValue": {
        const struct = v.kind.value as { fields?: Record<string, unknown> }
        if (!struct?.fields) return {}
        const out: Record<string, unknown> = {}
        for (const [key, fieldValue] of Object.entries(struct.fields)) {
          out[key] = this.protoValueToJs(fieldValue)
        }
        return out
      }
      case "listValue": {
        const list = v.kind.value as { values?: unknown[] }
        if (!list?.values) return []
        return list.values.map((item) => this.protoValueToJs(item))
      }
      default:
        return undefined
    }
  }

  private normalizeModelParameterId(id: string): string {
    return id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
  }

  private parsePositiveInteger(raw: string): number | undefined {
    const match = raw.trim().match(/-?\d+/)
    if (!match?.[0]) return undefined

    const parsed = Number.parseInt(match[0], 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return parsed
  }

  private extractRequestedModelParameters(
    parameters: RequestedModel_ModelParameterValue[]
  ): Record<string, string> | undefined {
    if (!parameters.length) return undefined

    const result: Record<string, string> = {}
    for (const parameter of parameters) {
      if (!parameter.id) continue
      const normalizedId = this.normalizeModelParameterId(parameter.id)
      if (!normalizedId) continue
      result[normalizedId] = parameter.value || ""
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  private mergeRequestedModelParameters(
    variantParameters?: Record<string, string>,
    explicitParameters?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!variantParameters && !explicitParameters) {
      return undefined
    }

    return {
      ...(variantParameters || {}),
      ...(explicitParameters || {}),
    }
  }

  private resolveCursorRequestedModel(
    requestedModelId?: string,
    modelDetailsModelId?: string,
    fallbackModel?: string
  ): {
    model: string
    requestedVariantSelection: ReturnType<
      typeof parseCursorVariantString
    > | null
    requestedBaseModel?: string
    modelDetailsVariantSelection: ReturnType<
      typeof parseCursorVariantString
    > | null
    modelDetailsBaseModel?: string
  } {
    const trimmedRequestedModelId = requestedModelId?.trim() || undefined
    const requestedVariantSelection = trimmedRequestedModelId
      ? parseCursorVariantString(trimmedRequestedModelId)
      : null
    const requestedBaseModel = trimmedRequestedModelId
      ? parseModelRequest(trimmedRequestedModelId).baseModel
      : undefined
    const trimmedModelDetailsModelId = modelDetailsModelId?.trim() || undefined
    const modelDetailsVariantSelection = trimmedModelDetailsModelId
      ? parseCursorVariantString(trimmedModelDetailsModelId)
      : null
    const modelDetailsBaseModel = trimmedModelDetailsModelId
      ? parseModelRequest(trimmedModelDetailsModelId).baseModel
      : undefined

    return {
      model:
        requestedVariantSelection?.baseModel ||
        requestedBaseModel ||
        modelDetailsVariantSelection?.baseModel ||
        modelDetailsBaseModel ||
        trimmedModelDetailsModelId ||
        fallbackModel ||
        "claude-sonnet-4-20250514",
      requestedVariantSelection,
      requestedBaseModel,
      modelDetailsVariantSelection,
      modelDetailsBaseModel,
    }
  }

  private resolveRequestedThinkingLevel(
    requestedModelParameters?: Record<string, string>
  ): 0 | 1 | 2 | undefined {
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

    const candidateValues: string[] = []
    for (const id of exactIds) {
      const value = requestedModelParameters[id]
      if (typeof value === "string" && value.trim().length > 0) {
        candidateValues.push(value)
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
      if (typeof rawValue === "string" && rawValue.trim().length > 0) {
        candidateValues.push(rawValue)
      }
    }

    for (const rawValue of candidateValues) {
      const normalized = normalizeRequestedThinkingEffort(rawValue)
      switch (normalized) {
        case "none":
          return 0
        case "minimal":
        case "low":
        case "medium":
        case "auto":
        case "high":
          return 1
        case "max":
        case "xhigh":
          return 2
        default:
          break
      }
    }

    return undefined
  }

  private extractNumericModelParameter(
    parameters: RequestedModel_ModelParameterValue[],
    predicate: (normalizedId: string) => boolean
  ): number | undefined {
    for (const parameter of parameters) {
      if (!parameter.id) continue
      const normalizedId = this.normalizeModelParameterId(parameter.id)
      if (!predicate(normalizedId)) continue

      const parsed = this.parsePositiveInteger(parameter.value || "")
      if (parsed !== undefined) return parsed
    }
    return undefined
  }

  private extractRequestedMaxOutputTokens(
    parameters: RequestedModel_ModelParameterValue[]
  ): number | undefined {
    const exactIds = new Set([
      "max_tokens",
      "max_output_tokens",
      "desired_max_tokens",
      "max_completion_tokens",
      "output_max_tokens",
      "max_new_tokens",
    ])

    const exact = this.extractNumericModelParameter(parameters, (id) =>
      exactIds.has(id)
    )
    if (exact !== undefined) return exact

    return this.extractNumericModelParameter(parameters, (id) => {
      if (!id.includes("token")) return false
      if (id.includes("context")) return false
      return (
        id.includes("max") ||
        id.includes("desired") ||
        id.includes("output") ||
        id.includes("completion")
      )
    })
  }

  private extractRequestedContextTokenLimit(
    parameters: RequestedModel_ModelParameterValue[]
  ): number | undefined {
    const exactIds = new Set([
      "max_context_tokens",
      "context_token_limit",
      "context_window",
      "context_window_size",
      "max_input_tokens",
    ])

    const exact = this.extractNumericModelParameter(parameters, (id) =>
      exactIds.has(id)
    )
    if (exact !== undefined) return exact

    return this.extractNumericModelParameter(parameters, (id) => {
      if (!id.includes("context")) return false
      return (
        id.includes("token") || id.includes("window") || id.includes("limit")
      )
    })
  }

  private decodeStateBytes(bytes: Uint8Array): string | null {
    if (!bytes || bytes.length === 0) return null
    try {
      return this.textDecoder.decode(bytes)
    } catch {
      return null
    }
  }

  private normalizeConversationRole(raw: unknown): "user" | "assistant" | null {
    if (typeof raw !== "string") return null
    const normalized = raw.trim().toLowerCase()
    if (
      normalized === "assistant" ||
      normalized === "model" ||
      normalized === "bot"
    ) {
      return "assistant"
    }
    if (normalized === "user" || normalized === "human") {
      return "user"
    }
    return null
  }

  private extractMessageText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""

    const textParts: string[] = []
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const block = part as {
        type?: unknown
        text?: unknown
        content?: unknown
      }
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text)
        continue
      }
      if (typeof block.content === "string") {
        textParts.push(block.content)
      }
    }

    return textParts.join("\n")
  }

  private parseConversationMessageCandidate(
    candidate: unknown
  ): { role: "user" | "assistant"; content: string } | null {
    if (!candidate || typeof candidate !== "object") return null
    const record = candidate as {
      role?: unknown
      author?: unknown
      type?: unknown
      content?: unknown
      text?: unknown
      message?: unknown
      messageText?: unknown
    }

    const role =
      this.normalizeConversationRole(record.role) ||
      this.normalizeConversationRole(record.author) ||
      this.normalizeConversationRole(record.type)
    if (!role) return null

    const content =
      (typeof record.content === "string" && record.content) ||
      this.extractMessageText(record.content) ||
      (typeof record.text === "string" ? record.text : "") ||
      (typeof record.message === "string" ? record.message : "") ||
      (typeof record.messageText === "string" ? record.messageText : "")

    if (!content) return null
    return { role, content }
  }

  private extractUserMessageFromReference(ref?: Uint8Array): string {
    const bytes = this.resolveProtocolReferenceBytes(ref)
    if (!bytes || bytes.length === 0) return ""

    try {
      const userMsg = fromBinary(UserMessageSchema, bytes)
      const prompt = this.extractUserMessagePrompt(userMsg)
      if (prompt.trim()) return prompt
    } catch {
      // Not a UserMessage protobuf.
    }

    return this.extractTextFromStructuredPayload(bytes.toString("utf8"))
  }

  private extractConversationStepMessageFromReference(
    ref?: Uint8Array
  ): { role: "assistant"; content: string } | null {
    const bytes = this.resolveProtocolReferenceBytes(ref)
    if (!bytes || bytes.length === 0) return null

    try {
      const step = fromBinary(ConversationStepSchema, bytes)
      if (step.message.case === "assistantMessage") {
        const content = step.message.value.text || ""
        return content ? { role: "assistant", content } : null
      }
    } catch {
      // Not a ConversationStep protobuf.
    }

    try {
      const assistant = fromBinary(AssistantMessageSchema, bytes)
      if (assistant.text) {
        return { role: "assistant", content: assistant.text }
      }
    } catch {
      // Not an AssistantMessage protobuf.
    }

    const candidate = this.parseConversationMessageCandidate(
      this.extractTextFromStructuredPayload(bytes.toString("utf8"))
    )
    return candidate?.role === "assistant"
      ? { role: "assistant", content: candidate.content }
      : null
  }

  private extractMessagesFromConversationTurnReference(
    ref?: Uint8Array
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const bytes = this.resolveProtocolReferenceBytes(ref)
    if (!bytes || bytes.length === 0) return []

    try {
      const turnStructure = fromBinary(ConversationTurnStructureSchema, bytes)
      if (turnStructure.turn.case !== "agentConversationTurn") {
        return []
      }

      const messages: Array<{
        role: "user" | "assistant"
        content: string
      }> = []
      const agentTurn = turnStructure.turn.value
      const userText = this.extractUserMessageFromReference(
        agentTurn.userMessage
      )
      if (userText.trim()) {
        messages.push({ role: "user", content: userText })
      }

      for (const stepRef of agentTurn.steps) {
        const msg = this.extractConversationStepMessageFromReference(stepRef)
        if (msg) messages.push(msg)
      }

      return messages
    } catch {
      return []
    }
  }

  private extractConversationHistoryFromState(
    state?: ConversationStateStructure
  ): Array<{ role: "user" | "assistant"; content: string }> {
    if (!state) return []

    const messages: Array<{ role: "user" | "assistant"; content: string }> = []

    const pushDedup = (msg: {
      role: "user" | "assistant"
      content: string
    }) => {
      const last = messages[messages.length - 1]
      if (last && last.role === msg.role && last.content === msg.content) return
      messages.push(msg)
    }

    const parseDecodedPayload = (decoded: string) => {
      if (!decoded || decoded.trim() === "") return
      try {
        const parsed = JSON.parse(decoded) as unknown
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const msg = this.parseConversationMessageCandidate(entry)
            if (msg) pushDedup(msg)
          }
          return
        }
        const msg = this.parseConversationMessageCandidate(parsed)
        if (msg) pushDedup(msg)
      } catch {
        // Some state blobs are protobuf-encoded turn structures; skip if not JSON.
      }
    }

    const parsePayloadOrReferencedBlob = (payload: Uint8Array) => {
      const decoded = this.decodeStateBytes(payload)
      if (decoded) {
        parseDecodedPayload(decoded)
        const blobBytes = this.getStoredBlobBytes(decoded)
        if (blobBytes) {
          parseDecodedPayload(blobBytes.toString("utf8"))
        }
      }
    }

    if (state.rootPromptMessagesJson?.length) {
      for (const payload of state.rootPromptMessagesJson) {
        parsePayloadOrReferencedBlob(payload)
      }
    }

    if (state.turns?.length) {
      for (const turn of state.turns) {
        const turnMessages =
          this.extractMessagesFromConversationTurnReference(turn)
        if (turnMessages.length > 0) {
          for (const msg of turnMessages) {
            pushDedup(msg)
          }
          continue
        }
        parsePayloadOrReferencedBlob(turn)
      }
    }

    if (messages.length > 0) {
      this.logger.log(
        `Rehydrated ${messages.length} message(s) from conversation_state`
      )
    }
    return messages
  }

  /**
   * 从 raw buffer 解析 Cursor 请求
   * 使用 @bufbuild/protobuf 的 fromBinary 替代手写 varint 解析
   */
  parseRequest(buffer: Buffer): ParsedCursorRequest | null {
    this.logger.debug(
      `parseRequest: buffer length=${buffer.length}, first 20 bytes: ${buffer.subarray(0, 20).toString("hex")}`
    )

    // 解压 GZIP
    let workingBuffer = buffer
    if (
      buffer.length >= 2 &&
      buffer[0] === GZIP_MAGIC[0] &&
      buffer[1] === GZIP_MAGIC[1]
    ) {
      this.logger.log("检测到 GZIP 压缩，解压中...")
      try {
        workingBuffer = zlib.gunzipSync(buffer)
        this.logger.log(`解压 ${buffer.length} → ${workingBuffer.length} bytes`)
      } catch (error) {
        this.logger.error("GZIP 解压失败", error)
        return null
      }
    }

    // 使用 fromBinary 解析 AgentClientMessage
    try {
      const msg = fromBinary(AgentClientMessageSchema, workingBuffer)
      CursorProtocolTraceService.recordClientMessage(msg, {
        bytes: workingBuffer.length,
        compressedBytes: workingBuffer === buffer ? undefined : buffer.length,
        context: "parseRequest",
      })
      const result = this.parseAgentClientMessage(msg)
      if (result) {
        this.logger.log(
          `解析成功: case=${msg.message.case}, mode=${result.unifiedMode}`
        )
        return result
      }
    } catch (error) {
      this.logger.debug(
        `AgentClientMessage 解析失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.logger.warn("无法解析请求")
    return null
  }

  /**
   * 从已解析的 AgentClientMessage 提取 ParsedCursorRequest
   */
  private parseAgentClientMessage(
    msg: AgentClientMessage
  ): ParsedCursorRequest | null {
    const { message } = msg

    switch (message.case) {
      case "runRequest":
        return this.parseRunRequest(message.value)

      case "execClientMessage":
        return this.parseExecClientMessage(message.value)

      case "clientHeartbeat":
        this.logger.debug("收到心跳消息")
        return makeControlMessage("heartbeat")

      case "execClientControlMessage":
        this.logger.debug("收到 execClientControlMessage")
        return this.parseExecClientControlMessage(message.value)

      case "conversationAction": {
        const triggeringUserInfo = message.value.triggeringUserInfo
        const triggeringFields: {
          triggeringAuthId?: string
          triggeringUserId?: number
        } = {}
        const triggeringAuthId =
          triggeringUserInfo?.authId || message.value.triggeringAuthId || ""
        if (triggeringAuthId) {
          triggeringFields.triggeringAuthId = triggeringAuthId
        }
        if (triggeringUserInfo?.userId !== undefined) {
          triggeringFields.triggeringUserId = triggeringUserInfo.userId
        }
        if (
          triggeringFields.triggeringAuthId ||
          triggeringFields.triggeringUserId !== undefined
        ) {
          this.logger.debug(
            `收到 conversationAction.triggeringUserInfo authId=${triggeringFields.triggeringAuthId || "(none)"} userId=${triggeringFields.triggeringUserId ?? "(none)"}`
          )
        }

        if (message.value.action.case === "userMessageAction") {
          this.logger.log("收到 conversationAction.userMessageAction")
          return this.parseConversationUserMessageAction(
            message.value.action.value,
            triggeringFields
          )
        }

        if (message.value.action.case === "cancelAction") {
          const reason = (message.value.action.value.reason || "").trim()
          this.logger.warn(
            `收到 conversationAction.cancelAction reason=${reason || "(empty)"}`
          )
          return makeControlMessage("cancelAction", {
            ...triggeringFields,
            error: reason,
          })
        }

        // ConversationAction 补齐：逐一识别并路由
        if (message.value.action.case === "summarizeAction") {
          this.logger.log("收到 conversationAction.summarizeAction")
          return makeControlMessage("summarizeAction", triggeringFields)
        }
        if (message.value.action.case === "shellCommandAction") {
          const shellAction = message.value.action.value as {
            shellCommand?: { command?: string }
            execId?: string
          }
          const command = shellAction.shellCommand?.command || ""
          const execId = shellAction.execId || ""
          this.logger.log(
            `收到 conversationAction.shellCommandAction command="${command.substring(0, 80)}" execId=${execId}`
          )
          return makeControlMessage("shellCommandAction", {
            ...triggeringFields,
            shellCommand: { command, execId },
          })
        }
        if (message.value.action.case === "startPlanAction") {
          this.logger.log("收到 conversationAction.startPlanAction")
          return makeControlMessage("startPlanAction", triggeringFields)
        }
        if (message.value.action.case === "executePlanAction") {
          this.logger.log("收到 conversationAction.executePlanAction")
          return makeControlMessage("executePlanAction", triggeringFields)
        }
        if (message.value.action.case === "asyncAskQuestionCompletionAction") {
          const completion = normalizeAsyncAskQuestionCompletionAction(
            message.value.action.value
          )

          this.logger.log(
            `收到 conversationAction.asyncAskQuestionCompletionAction toolCallId=${completion?.originalToolCallId || "(none)"} case=${completion?.resultCase || "unknown"} answers=${completion?.answers?.length ?? 0}`
          )
          return makeControlMessage("asyncAskQuestionCompletionAction", {
            ...triggeringFields,
            toolCallId: completion?.originalToolCallId || "",
            asyncAskCompletion: completion,
          })
        }
        if (message.value.action.case === "cancelSubagentAction") {
          const cancelSub = message.value.action.value as {
            subagentId?: string
          }
          this.logger.log(
            `收到 conversationAction.cancelSubagentAction subagentId=${cancelSub.subagentId || "(none)"}`
          )
          return makeControlMessage("cancelSubagentAction", {
            ...triggeringFields,
            subagentId: cancelSub.subagentId || "",
          })
        }
        if (message.value.action.case === "backgroundTaskCompletionAction") {
          const bgTask = message.value.action.value as {
            completions?: unknown
          }
          const completions = normalizeBackgroundTaskCompletions(
            bgTask.completions
          )
          this.logger.log(
            `收到 conversationAction.backgroundTaskCompletionAction completions=${completions.length}${completions.length ? ` ${summarizeBackgroundTaskCompletionsForLog(completions)}` : ""}`
          )
          return makeControlMessage("backgroundTaskCompletionAction", {
            ...triggeringFields,
            backgroundTaskCompletions: completions,
          })
        }
        if (message.value.action.case === "backgroundShellAction") {
          const bgShell = message.value.action.value as {
            toolCallId?: string
          }
          this.logger.log(
            `收到 conversationAction.backgroundShellAction toolCallId=${bgShell.toolCallId || "(none)"}`
          )
          return makeControlMessage("backgroundShellAction", {
            ...triggeringFields,
            toolCallId: bgShell.toolCallId || "",
          })
        }
        if (message.value.action.case === "backgroundSubagentAction") {
          const bgSub = message.value.action.value as {
            toolCallId?: string
          }
          this.logger.log(
            `收到 conversationAction.backgroundSubagentAction toolCallId=${bgSub.toolCallId || "(none)"}`
          )
          return makeControlMessage("backgroundSubagentAction", {
            ...triggeringFields,
            toolCallId: bgSub.toolCallId || "",
          })
        }

        this.logger.debug(
          `收到 conversationAction（未识别） action=${message.value.action.case || "(none)"}`
        )
        return makeControlMessage("other", triggeringFields)
      }

      case "kvClientMessage":
        this.logger.debug("收到 kvClientMessage")
        return makeControlMessage("other")

      case "interactionResponse": {
        const resp = message.value
        this.logger.log(
          `收到 interactionResponse id=${resp.id} case=${resp.result.case}`
        )
        // 统一提取嵌套 result oneof，兼容:
        // - XxxRequestResponse.result.{approved|rejected}
        // - AskQuestionInteractionResponse.result.result.{success|error|rejected|async}
        // - CreatePlanRequestResponse.result.result.{success|error}
        // - SetupVmEnvironmentResult.result.{success}
        let approved = false
        if (resp.result.case && resp.result.value) {
          const responseCase = resp.result.case
          // Use Record<string, unknown> instead of `any` for safe nested oneOf probing.
          // Each InteractionResponse variant has its own nested `result` oneOf structure:
          // - Level 1: value.result.case (e.g. SetupVmEnvironmentResult.result.{success})
          // - Level 2: value.result.result.case (e.g. AskQuestionInteractionResponse.result.result.{success|async})
          const value = resp.result.value as Record<string, unknown>
          const resultField = value?.result as
            | { case?: string; value?: Record<string, unknown> }
            | undefined
          const level1Case =
            typeof resultField?.case === "string" ? resultField.case : undefined
          const nestedResult =
            (resultField?.value?.result as { case?: string } | undefined) ||
            ((resultField as { result?: { case?: string } } | undefined)
              ?.result as { case?: string } | undefined)
          const level2Case =
            typeof nestedResult?.case === "string"
              ? nestedResult.case
              : undefined
          const effectiveCase = level2Case || level1Case

          if (responseCase === "setupVmEnvironmentResult") {
            approved = effectiveCase === "success"
          } else if (responseCase === "askQuestionInteractionResponse") {
            approved = effectiveCase === "success" || effectiveCase === "async"
          } else if (responseCase === "createPlanRequestResponse") {
            approved = effectiveCase === "success"
          } else {
            approved =
              effectiveCase === "approved" ||
              effectiveCase === "success" ||
              effectiveCase === "async" ||
              effectiveCase === undefined
          }
        }
        return {
          conversation: [],
          newMessage: "",
          model: "",
          thinkingLevel: 0,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools: [],
          useWeb: false,
          isAgentControlMessage: false,
          interactionResponse: {
            id: resp.id,
            resultCase: resp.result.case || "unknown",
            approved,
            rawResponse: resp,
          },
        }
      }

      case "prewarmRequest": {
        const prewarm = (msg.message.value || {}) as {
          requestedModel?: { modelId?: string }
          modelDetails?: { modelId?: string }
          conversationId?: string
        }
        const requestedModelId =
          prewarm.requestedModel?.modelId?.trim() || undefined
        const modelDetailsModelId =
          prewarm.modelDetails?.modelId?.trim() || undefined
        const { model } = this.resolveCursorRequestedModel(
          requestedModelId,
          modelDetailsModelId,
          prewarm.modelDetails?.modelId
        )
        this.logger.debug(
          `收到 prewarmRequest conversation=${prewarm.conversationId || "(none)"} model=${model || "(empty)"}`
        )
        return makeControlMessage("prewarm", {
          conversationId: prewarm.conversationId || undefined,
          model,
        })
      }

      case undefined:
        this.logger.debug("AgentClientMessage.message 未设置")
        return null

      default:
        this.logger.debug(`未知的 message case`)
        return makeControlMessage("other")
    }
  }

  private parseExecClientControlMessage(
    msg: ExecClientControlMessage
  ): ParsedCursorRequest {
    switch (msg.message.case) {
      case "heartbeat": {
        const execId = msg.message.value.id
        this.logger.debug(
          `收到 execClientControlMessage.heartbeat id=${execId}`
        )
        return makeControlMessage("execHeartbeat", { execId })
      }
      case "streamClose": {
        const execId = msg.message.value.id
        this.logger.debug(
          `收到 execClientControlMessage.streamClose id=${execId}`
        )
        return makeControlMessage("execStreamClose", { execId })
      }
      case "throw": {
        const execId = msg.message.value.id
        const error = msg.message.value.error || ""
        const stackTrace = msg.message.value.stackTrace || ""
        this.logger.warn(
          `收到 execClientControlMessage.throw id=${execId}, error=${error || "(empty)"}`
        )
        return makeControlMessage("execThrow", {
          execId,
          error,
          stackTrace,
        })
      }
      case undefined:
      default:
        this.logger.debug("execClientControlMessage.message 未设置")
        return makeControlMessage("other")
    }
  }

  private parseConversationUserMessageAction(
    action: UserMessageAction,
    triggeringFields?: {
      triggeringAuthId?: string
      triggeringUserId?: number
    }
  ): ParsedCursorRequest | null {
    void triggeringFields

    const prompt = this.extractUserMessagePrompt(action.userMessage)
    const attachedImages = this.extractAttachedImagesFromUserMessage(
      action.userMessage
    )

    if (!prompt.trim() && attachedImages.length === 0) {
      this.logger.debug("conversationAction.userMessageAction 中无有效 prompt")
      return null
    }

    const conversation: Array<{
      role: "user" | "assistant"
      content: string
    }> = []

    for (const prepended of action.prependUserMessages || []) {
      const text = this.extractUserMessagePrompt(prepended)
      if (text.trim()) {
        conversation.push({ role: "user", content: text })
      }
    }
    if (prompt.trim()) {
      conversation.push({ role: "user", content: prompt })
    }

    const requestContext = action.requestContext
    // Multi-root workspace extraction. See workspace-folders.ts for
    // the data flow — this single helper supersedes the previous
    // ad-hoc loops over repositoryInfo / gitRepos / previousWorkspaceUris
    // that were duplicated across every parser entry point.
    const { rootPath, workspaceFolders } = extractWorkspaceFoldersWithPrimary(
      requestContext,
      undefined
    )
    const directories = workspaceFolders.map((f) => f.path)

    const builtInToolCapabilityOptions = {
      webSearchEnabled: requestContext?.webSearchEnabled,
      webFetchEnabled: requestContext?.webFetchEnabled,
      readLintsEnabled: requestContext?.readLintsEnabled,
    }
    const supportedTools = getDefaultAgentToolNames(
      builtInToolCapabilityOptions
    )
    const useWeb =
      requestContext?.webSearchEnabled === true ||
      requestContext?.webFetchEnabled === true

    this.logger.log(
      `conversationAction.userMessageAction: prompt="${prompt.substring(0, 100)}...", ` +
        `workspace=${rootPath || "(none)"} folders=${workspaceFolders.length}, tools=${supportedTools.length}, useWeb=${useWeb}`
    )

    return {
      conversation,
      newMessage: prompt,
      model: "",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      projectContext: rootPath
        ? { rootPath, directories, files: [], workspaceFolders }
        : undefined,
      requestContextEnv: requestContext?.env
        ? {
            terminalsFolder:
              requestContext.env.terminalsFolder?.trim() || undefined,
            projectFolder:
              requestContext.env.projectFolder?.trim() || undefined,
            shell: requestContext.env.shell?.trim() || undefined,
            timeZone: requestContext.env.timeZone?.trim() || undefined,
            agentTranscriptsFolder:
              requestContext.env.agentTranscriptsFolder?.trim() || undefined,
            artifactsFolder:
              requestContext.env.artifactsFolder?.trim() || undefined,
          }
        : undefined,
      attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
    }
  }

  /**
   * 解析 AgentRunRequest → 提取 prompt、model、conversationId
   */
  private parseRunRequest(req: AgentRunRequest): ParsedCursorRequest | null {
    // 提取 prompt
    let prompt = ""
    const action = req.action
    const actionCase = action?.action.case
    let requestContext:
      | import("../../../gen/agent/v1_pb").RequestContext
      | undefined
    const statePendingToolCallIds =
      req.conversationState?.pendingToolCalls || []

    if (req.preFetchedBlobs?.length) {
      for (const blob of req.preFetchedBlobs) {
        const blobId = this.decodeBlobId(blob.id)
        if (blobId && blob.value?.length) {
          this.kvStorageService.storeBinaryBlob(blobId, blob.value)
        }
      }
      this.logger.debug(
        `Stored ${req.preFetchedBlobs.length} preFetchedBlob(s) from AgentRunRequest`
      )
    }

    const stateHistory = this.extractConversationHistoryFromState(
      req.conversationState
    )

    // 附加图片
    const attachedImages: AttachedImage[] = []

    if (action && actionCase === "userMessageAction") {
      const userMsg: UserMessage | undefined = action.action.value.userMessage
      if (userMsg) {
        prompt = this.extractUserMessagePrompt(userMsg)
        attachedImages.push(
          ...this.extractAttachedImagesFromUserMessage(userMsg)
        )
      }
      // 提取 requestContext（包含 workspace、rules 等信息）
      requestContext = action.action.value.requestContext
    } else if (action && actionCase === "resumeAction") {
      // Resume turns may not contain a new prompt, but still carry requestContext.
      requestContext = action.action.value.requestContext
    }

    const requestedModelId = req.requestedModel?.modelId?.trim() || undefined
    const modelDetailsModelId = req.modelDetails?.modelId?.trim() || undefined
    const {
      model,
      requestedVariantSelection,
      requestedBaseModel,
      modelDetailsVariantSelection,
      modelDetailsBaseModel,
    } = this.resolveCursorRequestedModel(
      requestedModelId,
      modelDetailsModelId,
      req.modelDetails?.modelId
    )

    // 提取 conversationId
    const conversationId = req.conversationId || undefined

    // 提取 workspace 路径（从 repositoryInfo 或 conversationState）
    // DEBUG: dump requestContext 关键字段
    if (requestContext) {
      this.logger.debug(
        `[DEBUG] requestContext fields: ` +
          `repositoryInfo=${requestContext.repositoryInfo?.length || 0}, ` +
          `gitRepos=${requestContext.gitRepos?.length || 0}, ` +
          `projectLayouts=${requestContext.projectLayouts?.length || 0}, ` +
          `tools=${requestContext.tools?.length || 0}, ` +
          `customSubagents=${requestContext.customSubagents?.length || 0}, ` +
          `rules=${requestContext.rules?.length || 0}, ` +
          `webSearchEnabled=${requestContext.webSearchEnabled}, ` +
          `webFetchEnabled=${requestContext.webFetchEnabled}`
      )
      if (requestContext.repositoryInfo?.length) {
        for (const repo of requestContext.repositoryInfo) {
          this.logger.debug(
            `[DEBUG] repo: workspaceUri="${repo.workspaceUri}", repoName="${repo.repoName}", isLocal=${repo.isLocal}`
          )
        }
      }
      if (requestContext.gitRepos?.length) {
        for (const git of requestContext.gitRepos) {
          this.logger.debug(
            `[DEBUG] gitRepo: ${JSON.stringify(git).substring(0, 200)}`
          )
        }
      }
      // DEBUG: dump 每条 rule 的关键信息，排查用户自定义规则是否被发送
      if (requestContext.rules?.length) {
        for (let i = 0; i < requestContext.rules.length; i++) {
          const r = requestContext.rules[i]!
          const typeCase = r.type?.type.case || "(none)"
          const contentPreview = (r.content || "")
            .substring(0, 80)
            .replace(/\n/g, "\\n")
          this.logger.debug(
            `[DEBUG] rule[${i}]: type=${typeCase}, source=${r.source}, ` +
              `path="${r.fullPath || ""}", content="${contentPreview}..."`
          )
        }
      }
    } else {
      this.logger.debug("[DEBUG] requestContext is undefined")
    }
    // DEBUG: dump selectedContext.cursorRules
    if (action && actionCase === "userMessageAction") {
      const _userMsg = action.action.value.userMessage
      const _selRules = _userMsg?.selectedContext?.cursorRules
      this.logger.debug(
        `[DEBUG] selectedContext.cursorRules: ${_selRules?.length ?? "undefined"} item(s)`
      )
      if (_selRules?.length) {
        for (let i = 0; i < _selRules.length; i++) {
          const sr = _selRules[i]!
          const r = sr.rule
          if (r) {
            const contentPreview = (r.content || "")
              .substring(0, 80)
              .replace(/\n/g, "\\n")
            this.logger.debug(
              `[DEBUG] selectedCursorRule[${i}]: type=${r.type?.type.case || "(none)"}, ` +
                `source=${r.source}, path="${r.fullPath || ""}", content="${contentPreview}..."`
            )
          } else {
            this.logger.debug(
              `[DEBUG] selectedCursorRule[${i}]: rule is undefined`
            )
          }
        }
      }
    }
    if (req.conversationState) {
      this.logger.debug(
        `[DEBUG] conversationState: previousWorkspaceUris=${JSON.stringify(req.conversationState.previousWorkspaceUris)}`
      )
      if (req.conversationState.tokenDetails) {
        this.logger.debug(
          `[DEBUG] conversationState.tokenDetails: used=${req.conversationState.tokenDetails.usedTokens}, max=${req.conversationState.tokenDetails.maxTokens}`
        )
      }
    }
    // Multi-root workspace extraction (parseRunRequest path).
    // Same helper as the conversationAction.userMessageAction path,
    // but with conversationState available so previousWorkspaceUris
    // is consulted as a resume-time fallback. See workspace-folders.ts.
    const { rootPath, workspaceFolders } = extractWorkspaceFoldersWithPrimary(
      requestContext,
      req.conversationState
    )
    const directories = workspaceFolders.map((f) => f.path)

    // 提取 Cursor Rules
    // 规则来自两个来源：
    //   1. requestContext.rules — 工作区级别的 rules（Cursor skills、项目 .cursor/rules 等）
    //   2. userMsg.selectedContext.cursorRules — 用户手动创建的全局 rules（如 "Always Apply" 类型）
    // 两者合并后去重（按 fullPath），确保用户自定义规则不会丢失。
    //
    // 过滤 Cursor 根据系统 locale 自动注入的语言 rule（如 "Always respond in Chinese-simplified"）。
    // 这类 rule 由客户端在每次启动时写入 aicontext.personalContext，
    // 与用户自定义的 rule 叠加而非覆盖，导致删除后重启又出现。
    // 当用户已有自定义 rule 时，这条自动 rule 是多余的，直接过滤即可。
    const AUTO_LANG_RULE_PATTERN = /^Always respond in [A-Za-z-]+$/i

    // 收集 requestContext.rules
    const contextRules = requestContext?.rules ? [...requestContext.rules] : []
    const selectedCursorRulePaths = new Set<string>()
    const selectedCursorRuleNames = new Set<string>()

    // 收集 selectedContext.cursorRules（SelectedCursorRule 包装了 CursorRule）
    if (action && actionCase === "userMessageAction") {
      const userMsg = action.action.value.userMessage
      const selectedRules = userMsg?.selectedContext?.cursorRules
      if (selectedRules && selectedRules.length > 0) {
        // 用 fullPath 集合去重，避免同一条规则重复注入
        const existingPaths = new Set(
          contextRules.map((r) => r.fullPath).filter(Boolean)
        )
        for (const selected of selectedRules) {
          if (selected.rule) {
            if (selected.rule.fullPath) {
              selectedCursorRulePaths.add(
                normalizePathForMatch(selected.rule.fullPath)
              )
            }
            const selectedSkill = getCursorSkillMetadata(selected.rule)
            if (selectedSkill?.name) {
              selectedCursorRuleNames.add(
                normalizeSkillName(selectedSkill.name)
              )
            }
            if (
              !selected.rule.fullPath ||
              !existingPaths.has(selected.rule.fullPath)
            ) {
              contextRules.push(selected.rule)
              if (selected.rule.fullPath) {
                existingPaths.add(selected.rule.fullPath)
              }
            }
          }
        }
        this.logger.log(
          `Merged ${selectedRules.length} rule(s) from selectedContext.cursorRules ` +
            `(total after merge: ${contextRules.length})`
        )
      }
    }

    // 过滤自动注入的语言 rule 并生成最终列表
    const cursorRules =
      contextRules.length > 0
        ? contextRules.filter((rule) => {
            const content = rule.content?.trim() || ""
            if (AUTO_LANG_RULE_PATTERN.test(content)) {
              this.logger.log(
                `Filtered auto-injected locale rule: "${content}"`
              )
              return false
            }
            return true
          })
        : undefined

    // 提取 Cursor Commands (/ 命令)
    const cursorCommands: Array<{ name: string; content: string }> = []
    if (action && actionCase === "userMessageAction") {
      const userMsg = action.action.value.userMessage
      const cmds = userMsg?.selectedContext?.cursorCommands
      if (cmds && cmds.length > 0) {
        for (const cmd of cmds) {
          if (cmd.name && cmd.content) {
            cursorCommands.push({ name: cmd.name, content: cmd.content })
          }
        }
      }
    }

    // 提取 custom system prompt
    const customSystemPrompt = req.customSystemPrompt || ""

    // 提取协议里的 token 参数（优先使用 Cursor 传值）
    const explicitRequestedModelParameters =
      this.extractRequestedModelParameters(req.requestedModel?.parameters || [])
    const variantRequestedModelParameters = this.mergeRequestedModelParameters(
      modelDetailsVariantSelection?.parameterValues,
      requestedVariantSelection?.parameterValues
    )
    const requestedModelParameters = this.mergeRequestedModelParameters(
      variantRequestedModelParameters,
      explicitRequestedModelParameters
    )
    const modelMaxMode = req.modelDetails?.maxMode === true
    const requestedMaxMode = req.requestedModel?.maxMode === true
    const requestedVariantMaxMode = requestedVariantSelection?.maxMode === true
    const modelDetailsVariantMaxMode =
      modelDetailsVariantSelection?.maxMode === true
    const requestedMaxOutputTokens = this.extractRequestedMaxOutputTokens(
      req.requestedModel?.parameters || []
    )
    const requestedContextTokenLimit = this.extractRequestedContextTokenLimit(
      req.requestedModel?.parameters || []
    )
    const usedContextTokens =
      req.conversationState?.tokenDetails &&
      req.conversationState.tokenDetails.usedTokens > 0
        ? req.conversationState.tokenDetails.usedTokens
        : undefined
    const rawContextTokenLimitFromState =
      req.conversationState?.tokenDetails &&
      req.conversationState.tokenDetails.maxTokens > 0
        ? req.conversationState.tokenDetails.maxTokens
        : undefined
    const explicitMaxContextMode =
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode
    const contextTokenLimitFromState =
      rawContextTokenLimitFromState &&
      !requestedContextTokenLimit &&
      (explicitMaxContextMode ||
        rawContextTokenLimitFromState <=
          this.normalStateContextTokenLimitCeiling)
        ? rawContextTokenLimitFromState
        : undefined
    if (
      rawContextTokenLimitFromState &&
      !requestedContextTokenLimit &&
      !contextTokenLimitFromState
    ) {
      this.logger.debug(
        `Ignoring conversationState.tokenDetails.maxTokens=${rawContextTokenLimitFromState} without explicit max-mode signal`
      )
    }
    const contextTokenLimit =
      requestedContextTokenLimit ||
      (explicitMaxContextMode ? undefined : contextTokenLimitFromState)

    if (
      contextTokenLimit ||
      requestedMaxOutputTokens ||
      explicitMaxContextMode
    ) {
      this.logger.log(
        `Token budget from protocol: contextLimit=${contextTokenLimit || "(none)"}, ` +
          `usedContext=${usedContextTokens || "(none)"}, maxOutput=${requestedMaxOutputTokens || "(none)"}, ` +
          `maxMode=${explicitMaxContextMode}`
      )
    }

    if (req.requestedModel) {
      this.logger.debug(
        `RequestedModel: modelId=${req.requestedModel.modelId || "(empty)"}, ` +
          `isVariant=${req.requestedModel.isVariantStringRepresentation}, ` +
          `parameterCount=${req.requestedModel.parameters.length}, ` +
          `baseModel=${requestedVariantSelection?.baseModel || requestedBaseModel || "(none)"}, ` +
          `derivedParameters=${requestedModelParameters ? JSON.stringify(requestedModelParameters) : "(none)"}, ` +
          `requestedMaxMode=${req.requestedModel.maxMode}`
      )
    }

    if (modelDetailsModelId) {
      this.logger.debug(
        `ModelDetails: modelId=${modelDetailsModelId}, ` +
          `baseModel=${modelDetailsVariantSelection?.baseModel || modelDetailsBaseModel || "(none)"}, ` +
          `derivedParameters=${modelDetailsVariantSelection?.parameterValues ? JSON.stringify(modelDetailsVariantSelection.parameterValues) : "(none)"}, ` +
          `modelMaxMode=${req.modelDetails?.maxMode === true}`
      )
    }

    // 提取支持的工具
    // RequestContext.tools / mcp_tools 只承载 MCP 定义；内置 Cursor 工具需要结合
    // capability flags 和 customSubagents[].tools 一起判断，避免把显式工具选择扩回默认全集。
    const builtInToolCapabilityOptions = {
      webSearchEnabled: requestContext?.webSearchEnabled,
      webFetchEnabled: requestContext?.webFetchEnabled,
      readLintsEnabled: requestContext?.readLintsEnabled,
    }
    const defaultBuiltInTools = getDefaultAgentToolNames(
      builtInToolCapabilityOptions
    )
    const defaultBuiltInToolSet = new Set(defaultBuiltInTools)
    const supportedToolsSet = new Set<string>()

    const appendSupportedToolName = (toolName?: string) => {
      if (!toolName) return
      if (!isCursorBuiltInToolAllowed(toolName, builtInToolCapabilityOptions)) {
        return
      }
      supportedToolsSet.add(toolName)
    }

    const appendDeclaredMcpToolName = (tool: {
      name?: string
      toolName?: string
    }) => {
      if (tool.name) {
        appendSupportedToolName(tool.name)
        return
      }
      if (tool.toolName) {
        appendSupportedToolName(tool.toolName)
      }
    }

    if (requestContext?.tools?.length) {
      for (const tool of requestContext.tools) {
        appendDeclaredMcpToolName(tool)
      }
    }

    // Some payload variants carry MCP declarations in top-level mcp_tools.
    if (req.mcpTools?.mcpTools?.length) {
      for (const tool of req.mcpTools.mcpTools) {
        appendDeclaredMcpToolName(tool)
      }
    }

    if (requestContext?.customSubagents?.length) {
      for (const subagent of requestContext.customSubagents) {
        if (!subagent.tools?.length) continue
        for (const toolName of subagent.tools) {
          appendSupportedToolName(toolName)
        }
      }
    }

    const hasBuiltInCursorTools = Array.from(supportedToolsSet).some((name) =>
      defaultBuiltInToolSet.has(name)
    )
    const hasExplicitCustomSubagentToolSelection =
      requestContext?.customSubagents?.some(
        (subagent) => !!subagent.tools?.length
      ) ?? false

    if (!hasBuiltInCursorTools && !hasExplicitCustomSubagentToolSelection) {
      for (const toolName of defaultBuiltInTools) {
        supportedToolsSet.add(toolName)
      }
    }

    const supportedTools = Array.from(supportedToolsSet)

    // 提取 MCP 工具完整定义（含 input_schema）
    const mcpToolDefsByName = new Map<string, McpToolDef>()
    const appendMcpToolDef = (tool: {
      name?: string
      toolName?: string
      providerIdentifier?: string
      description?: string
      inputSchema?: unknown
    }) => {
      const name = tool.name || tool.toolName
      if (!name || mcpToolDefsByName.has(name)) return
      const def: McpToolDef = {
        name,
        toolName: tool.toolName || name,
        providerIdentifier: tool.providerIdentifier || "",
        description: tool.description || "",
        ideRegistryKey: computeMcpIdeRegistryKey({
          name,
          toolName: tool.toolName || name,
          providerIdentifier: tool.providerIdentifier || "",
        }),
      }
      if (tool.inputSchema) {
        try {
          def.inputSchema = this.protoValueToJs(tool.inputSchema) as Record<
            string,
            unknown
          >
        } catch {
          // inputSchema 解析失败则跳过
        }
      }
      mcpToolDefsByName.set(name, def)
    }

    // Primary source: RequestContext.tools (Cursor Agent turn payload)
    if (requestContext?.tools?.length) {
      for (const tool of requestContext.tools) {
        appendMcpToolDef(tool)
      }
    }
    // Fallback source: top-level mcp_tools (some protocol variants)
    if (req.mcpTools?.mcpTools?.length) {
      for (const tool of req.mcpTools.mcpTools) {
        appendMcpToolDef(tool)
      }
    }
    const mcpToolDefs = Array.from(mcpToolDefsByName.values())
    if (mcpToolDefs.length > 0) {
      this.logger.log(
        `Extracted ${mcpToolDefs.length} MCP tool definitions: ${mcpToolDefs.map((d) => d.name).join(", ")}`
      )
    }
    const useWeb =
      requestContext?.webSearchEnabled === true ||
      requestContext?.webFetchEnabled === true
    const requestContextEnv = requestContext?.env
      ? {
          terminalsFolder:
            requestContext.env.terminalsFolder?.trim() || undefined,
          projectFolder: requestContext.env.projectFolder?.trim() || undefined,
          shell: requestContext.env.shell?.trim() || undefined,
          timeZone: requestContext.env.timeZone?.trim() || undefined,
          agentTranscriptsFolder:
            requestContext.env.agentTranscriptsFolder?.trim() || undefined,
          artifactsFolder:
            requestContext.env.artifactsFolder?.trim() || undefined,
        }
      : undefined

    if (prompt) {
      this.logger.log(
        `AgentRunRequest: prompt="${prompt.substring(0, 100)}...", model=${model}, ` +
          `workspace=${rootPath || "(none)"}, rules=${cursorRules?.length || 0}, ` +
          `customPrompt=${customSystemPrompt ? customSystemPrompt.length + " chars" : "none"}, ` +
          `tools=${supportedTools.length}, useWeb=${useWeb}`
      )
    }

    // 推导 thinkingLevel
    // - modelDetails.maxMode 或 requestedModel.maxMode → 最大 thinking (level 2)
    // - modelDetails.thinkingDetails 存在（presence）→ thinking 已启用 (level 1)
    //
    // 不再根据 model-registry 自动猜测 thinking：
    // Cursor 是否显式请求 think 应以协议字段为准，避免 bridge 擅自开启。
    const hasThinkingDetails = !!req.modelDetails?.thinkingDetails
    const requestedThinkingLevel = this.resolveRequestedThinkingLevel(
      requestedModelParameters
    )
    let thinkingLevel = 0
    if (
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode
    ) {
      thinkingLevel = 2
    } else if (hasThinkingDetails) {
      thinkingLevel = 1
    } else if (requestedThinkingLevel !== undefined) {
      thinkingLevel = requestedThinkingLevel
    }

    // thinkingDetailsRequested 表示客户端希望看到详细的 thinking 内容（不仅是“启用 thinking”）。
    //
    // 之前只看 modelDetails.thinkingDetails，但 Cursor 通过 model variant
    // (例如 gpt-5.5-xhigh-fast → derivedParameters.thinking=extra-high) 显式请求
    // thinking 时不会带 thinkingDetails 字段，导致 thinkingDetails=false。
    //
    // 这里把 variant/参数推导出的 thinking 也视为“显式请求 thinking 详情”：
    // - modelDetails.thinkingDetails 存在
    // - requestedModel/modelDetails 进入 maxMode
    // - 通过 requestedModelParameters 解析出非零 thinking level
    const thinkingDetailsRequested =
      hasThinkingDetails ||
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode ||
      (requestedThinkingLevel !== undefined && requestedThinkingLevel > 0)

    if (thinkingLevel > 0) {
      this.logger.log(
        `Thinking enabled: level=${thinkingLevel} (thinkingDetails=${hasThinkingDetails}, ` +
          `thinkingDetailsRequested=${thinkingDetailsRequested}, ` +
          `modelMaxMode=${modelMaxMode}, requestedMaxMode=${requestedMaxMode}, requestedVariantMaxMode=${requestedVariantMaxMode}, modelDetailsVariantMaxMode=${modelDetailsVariantMaxMode}, ` +
          `requestedThinkingLevel=${requestedThinkingLevel ?? 0})`
      )
    }

    if (!prompt.trim() && attachedImages.length === 0 && !actionCase) {
      const stateTail = stateHistory[stateHistory.length - 1]
      if (stateTail?.role === "user" && stateTail.content.trim()) {
        prompt = stateTail.content
        this.logger.log(
          `AgentRunRequest inferred prompt from conversation_state tail (${prompt.length} chars)`
        )
      }
    }

    const hasUserInput = prompt.length > 0 || attachedImages.length > 0

    if (!hasUserInput) {
      if (actionCase === "cancelAction") {
        const reason =
          action?.action.case === "cancelAction"
            ? (action.action.value.reason || "").trim()
            : ""
        this.logger.log(
          `AgentRunRequest cancelAction: conversationId=${conversationId || "(none)"}, reason=${reason || "(empty)"}`
        )
        return makeControlMessage("cancelAction", {
          conversationId,
          error: reason,
        })
      }

      if (actionCase === "resumeAction") {
        this.logger.log(
          `AgentRunRequest resumeAction: conversationId=${conversationId || "(none)"}, pendingToolCalls=${req.conversationState?.pendingToolCalls?.length || 0}`
        )
        return {
          conversation: stateHistory,
          newMessage: "",
          model,
          thinkingLevel,
          thinkingDetailsRequested,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools,
          useWeb,
          conversationId,
          projectContext: rootPath
            ? { rootPath, directories, files: [], workspaceFolders }
            : undefined,
          cursorRules,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          requestContextEnv,
          isResumeAction: true,
          resumePendingToolCallIds: statePendingToolCallIds,
          statePendingToolCallIds,
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
        }
      }

      if (action && actionCase && actionCase !== "userMessageAction") {
        const control = (() => {
          switch (actionCase) {
            case "summarizeAction":
              this.logger.log(
                `AgentRunRequest summarizeAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("summarizeAction", {
                conversationId,
                model,
              })
            case "shellCommandAction": {
              const shellAction = action.action.value as {
                shellCommand?: { command?: string }
                execId?: string
              }
              const command = shellAction.shellCommand?.command || ""
              const execId = shellAction.execId || ""
              this.logger.log(
                `AgentRunRequest shellCommandAction: conversationId=${conversationId || "(none)"} command="${command.substring(0, 80)}" execId=${execId}`
              )
              return makeControlMessage("shellCommandAction", {
                conversationId,
                model,
                shellCommand: { command, execId },
              })
            }
            case "startPlanAction":
              this.logger.log(
                `AgentRunRequest startPlanAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("startPlanAction", {
                conversationId,
                model,
              })
            case "executePlanAction":
              this.logger.log(
                `AgentRunRequest executePlanAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("executePlanAction", {
                conversationId,
                model,
              })
            case "asyncAskQuestionCompletionAction": {
              const completion = normalizeAsyncAskQuestionCompletionAction(
                action.action.value
              )
              this.logger.log(
                `AgentRunRequest asyncAskQuestionCompletionAction: conversationId=${conversationId || "(none)"} toolCallId=${completion?.originalToolCallId || "(none)"} case=${completion?.resultCase || "unknown"} answers=${completion?.answers?.length ?? 0}`
              )
              return makeControlMessage("asyncAskQuestionCompletionAction", {
                conversationId,
                model,
                toolCallId: completion?.originalToolCallId || "",
                asyncAskCompletion: completion,
              })
            }
            case "cancelSubagentAction": {
              const cancelSub = action.action.value as {
                subagentId?: string
              }
              this.logger.log(
                `AgentRunRequest cancelSubagentAction: conversationId=${conversationId || "(none)"} subagentId=${cancelSub.subagentId || "(none)"}`
              )
              return makeControlMessage("cancelSubagentAction", {
                conversationId,
                model,
                subagentId: cancelSub.subagentId || "",
              })
            }
            case "backgroundTaskCompletionAction": {
              const bgTask = action.action.value as {
                completions?: unknown
              }
              const completions = normalizeBackgroundTaskCompletions(
                bgTask.completions
              )
              this.logger.log(
                `AgentRunRequest backgroundTaskCompletionAction: conversationId=${conversationId || "(none)"} completions=${completions.length}${completions.length ? ` ${summarizeBackgroundTaskCompletionsForLog(completions)}` : ""}`
              )
              return makeControlMessage("backgroundTaskCompletionAction", {
                conversationId,
                model,
                backgroundTaskCompletions: completions,
              })
            }
            case "backgroundShellAction": {
              const bgShell = action.action.value as {
                toolCallId?: string
              }
              this.logger.log(
                `AgentRunRequest backgroundShellAction: conversationId=${conversationId || "(none)"} toolCallId=${bgShell.toolCallId || "(none)"}`
              )
              return makeControlMessage("backgroundShellAction", {
                conversationId,
                model,
                toolCallId: bgShell.toolCallId || "",
              })
            }
            case "backgroundSubagentAction": {
              const bgSub = action.action.value as {
                toolCallId?: string
              }
              this.logger.log(
                `AgentRunRequest backgroundSubagentAction: conversationId=${conversationId || "(none)"} toolCallId=${bgSub.toolCallId || "(none)"}`
              )
              return makeControlMessage("backgroundSubagentAction", {
                conversationId,
                model,
                toolCallId: bgSub.toolCallId || "",
              })
            }
            default:
              this.logger.log(
                `AgentRunRequest control action: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("other", {
                conversationId,
                model,
              })
          }
        })()

        return {
          ...control,
          conversation: stateHistory,
          model: control.model || model,
          thinkingLevel,
          thinkingDetailsRequested,
          supportedTools,
          useWeb,
          conversationId,
          projectContext: rootPath
            ? { rootPath, directories, files: [], workspaceFolders }
            : undefined,
          cursorRules,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          requestContextEnv,
          statePendingToolCallIds,
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
        }
      }

      if (
        !actionCase &&
        (conversationId ||
          req.conversationState ||
          requestedModelId ||
          modelDetailsModelId)
      ) {
        this.logger.log(
          `AgentRunRequest attach-only: conversationId=${conversationId || "(none)"}, model=${model}, ` +
            `history=${stateHistory.length}, tools=${supportedTools.length}`
        )
        return {
          conversation: stateHistory,
          newMessage: "",
          model,
          thinkingLevel,
          thinkingDetailsRequested,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools,
          useWeb,
          conversationId,
          projectContext: rootPath
            ? { rootPath, directories, files: [], workspaceFolders }
            : undefined,
          cursorRules,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          requestContextEnv,
          isAgentControlMessage: true,
          agentControlType: "other",
          statePendingToolCallIds,
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
        }
      }

      this.logger.debug("AgentRunRequest 中无有效 prompt")
      return null
    }

    const conversation = [...stateHistory]
    const tail = conversation[conversation.length - 1]
    if (
      !(
        tail &&
        tail.role === "user" &&
        tail.content === prompt &&
        !(prompt.length === 0 && attachedImages.length > 0)
      )
    ) {
      conversation.push({ role: "user", content: prompt })
    }

    return {
      conversation,
      newMessage: prompt,
      model,
      thinkingLevel,
      thinkingDetailsRequested,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      conversationId,
      projectContext: rootPath
        ? { rootPath, directories, files: [], workspaceFolders }
        : undefined,
      cursorRules,
      selectedCursorRulePaths:
        selectedCursorRulePaths.size > 0
          ? Array.from(selectedCursorRulePaths)
          : undefined,
      selectedCursorRuleNames:
        selectedCursorRuleNames.size > 0
          ? Array.from(selectedCursorRuleNames)
          : undefined,
      cursorCommands: cursorCommands.length > 0 ? cursorCommands : undefined,
      customSystemPrompt: customSystemPrompt || undefined,
      contextTokenLimit,
      contextMaxMode: explicitMaxContextMode,
      usedContextTokens,
      requestedMaxOutputTokens,
      requestedModelParameters,
      requestContextEnv,
      statePendingToolCallIds,
      mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
      attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
    }
  }

  /**
   * 解析 ExecClientMessage → 提取 tool 结果
   * 使用生成的类型直接访问 oneof 字段
   */
  private parseExecClientMessage(
    msg: ExecClientMessage
  ): ParsedCursorRequest | null {
    const execId = msg.execId || ""
    const numericId = msg.id // ExecServerMessage.id ↔ ExecClientMessage.id 配对
    const messageCase = msg.message.case

    if (!messageCase) {
      this.logger.debug("ExecClientMessage.message 未设置")
      return null
    }

    // 将 oneof case 映射为下划线格式的 resultCase
    const resultCase = EXEC_RESULT_CASE_MAP[messageCase] || messageCase

    this.logger.log(
      `ExecClientMessage: id=${numericId}, exec_id=${execId}, case=${resultCase}`
    )

    // 将整个 ExecClientMessage 重新序列化为 Buffer 传递给下游
    // 下游会用 fromBinary 读取具体的 result 字段
    const resultData = Buffer.from(toBinary(ExecClientMessageSchema, msg))

    // 使用 execId 作为 toolCallId（与 ExecServerMessage.execId 配对）
    // numericId 用于 ExecServerMessage.id ↔ ExecClientMessage.id 的请求/响应匹配
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
          toolCallId: execId,
          toolType: numericId, // 存储 numeric id 用于配对
          resultCase,
          resultData,
        },
      ],
    }
  }

  /**
   * 解析 tool 结果（兼容旧接口）
   * 现在直接使用 fromBinary 解析 ExecClientMessage
   */
  public parseToolResult(buffer: Buffer): ParsedToolResult | null {
    try {
      const msg = fromBinary(ExecClientMessageSchema, buffer)
      const execId = msg.execId || ""
      const messageCase = msg.message.case

      if (!messageCase) {
        this.logger.debug("parseToolResult: ExecClientMessage.message 未设置")
        return null
      }

      const resultCase = EXEC_RESULT_CASE_MAP[messageCase] || messageCase

      this.logger.log(`parseToolResult: exec_id=${execId}, case=${resultCase}`)

      // 重新序列化为 buffer 传递给下游
      const data = Buffer.from(toBinary(ExecClientMessageSchema, msg))
      return {
        toolCallId: execId,
        toolType: msg.id,
        resultCase,
        resultData: data,
      }
    } catch (error) {
      this.logger.error("parseToolResult 失败", error)
      return null
    }
  }
}

// 单例
export const cursorRequestParser = new CursorRequestParser()
