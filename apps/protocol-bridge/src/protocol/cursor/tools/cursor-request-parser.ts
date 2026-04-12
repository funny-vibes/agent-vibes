import { fromBinary, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import * as zlib from "zlib"

import {
  AgentClientMessage,
  AgentClientMessageSchema,
  AgentRunRequest,
  ConversationStateStructure,
  type CursorRule,
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientMessageSchema,
  InteractionResponse,
  type RequestedModel_ModelParameterValue,
  UserMessage,
} from "../../../gen/agent/v1_pb"
import { parseModelRequest } from "../../../llm/shared/model-request"
import { normalizeRequestedThinkingEffort } from "../../../llm/shared/thinking-intent"
import { parseCursorVariantString } from "../cursor-model-protocol"
import {
  getDefaultAgentToolNames,
  isCursorBuiltInToolAllowed,
} from "./cursor-tool-mapper"
import { KvStorageService } from "../kv-storage.service"

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

  // Cursor Commands (/ 命令 — 用户定义的可复用工作流)
  cursorCommands?: Array<{ name: string; content: string }>

  // 自定义 system prompt（来自 AgentRunRequest.customSystemPrompt）
  customSystemPrompt?: string

  // 协议中的 token 预算（用于严格跟随 Cursor 参数）
  contextTokenLimit?: number
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
    | "other"
  agentControlExecId?: number
  agentControlError?: string
  agentControlStackTrace?: string

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
    | "other",
  options?: {
    conversationId?: string
    execId?: number
    error?: string
    stackTrace?: string
  }
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
    conversationId: options?.conversationId,
    isAgentControlMessage: true,
    agentControlType,
    agentControlExecId: options?.execId,
    agentControlError: options?.error,
    agentControlStackTrace: options?.stackTrace,
  }
}

export class CursorRequestParser {
  private readonly logger = new Logger(CursorRequestParser.name)

  private readonly textDecoder = new TextDecoder()

  constructor(
    private readonly kvStorageService: KvStorageService = new KvStorageService()
  ) {}

  private decodeBlobId(blobId: Uint8Array): string {
    return this.textDecoder.decode(blobId)
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

    if (state.rootPromptMessagesJson?.length) {
      for (const payload of state.rootPromptMessagesJson) {
        const decoded = this.decodeStateBytes(payload)
        if (decoded) parseDecodedPayload(decoded)
      }
    }

    if (state.turns?.length) {
      for (const turn of state.turns) {
        const decoded = this.decodeStateBytes(turn)
        if (decoded) parseDecodedPayload(decoded)
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

      case "conversationAction":
        if (message.value.action.case === "cancelAction") {
          const reason = (message.value.action.value.reason || "").trim()
          this.logger.warn(
            `收到 conversationAction.cancelAction reason=${reason || "(empty)"}`
          )
          return makeControlMessage("cancelAction", {
            error: reason,
          })
        }

        this.logger.debug(
          `收到 conversationAction（非 runRequest） action=${message.value.action.case || "(none)"}`
        )
        return makeControlMessage("other")

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
          const nestedResult = resultField?.value?.result as
            | { case?: string }
            | undefined
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

      case "prewarmRequest":
        this.logger.debug("收到 prewarmRequest")
        return makeControlMessage("other")

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
    const stateHistory = this.extractConversationHistoryFromState(
      req.conversationState
    )

    // 附加图片
    const attachedImages: AttachedImage[] = []

    if (action && actionCase === "userMessageAction") {
      const userMsg: UserMessage | undefined = action.action.value.userMessage
      if (userMsg) {
        prompt = userMsg.text

        // 提取 selectedContext.selectedImages 中的图片数据
        if (userMsg.selectedContext?.selectedImages?.length) {
          for (const img of userMsg.selectedContext.selectedImages) {
            const mimeType = img.mimeType || "image/png"
            let base64Data: string | undefined

            switch (img.dataOrBlobId.case) {
              case "data":
                base64Data = Buffer.from(img.dataOrBlobId.value).toString(
                  "base64"
                )
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
        }
      }
      // 提取 requestContext（包含 workspace、rules 等信息）
      requestContext = action.action.value.requestContext
    } else if (action && actionCase === "resumeAction") {
      // Resume turns may not contain a new prompt, but still carry requestContext.
      requestContext = action.action.value.requestContext
    }

    const requestedModelId = req.requestedModel?.modelId?.trim() || undefined
    const requestedVariantSelection = requestedModelId
      ? parseCursorVariantString(requestedModelId)
      : null
    const requestedBaseModel = requestedModelId
      ? parseModelRequest(requestedModelId).baseModel
      : undefined
    const modelDetailsModelId = req.modelDetails?.modelId?.trim() || undefined
    const modelDetailsVariantSelection = modelDetailsModelId
      ? parseCursorVariantString(modelDetailsModelId)
      : null
    const modelDetailsBaseModel = modelDetailsModelId
      ? parseModelRequest(modelDetailsModelId).baseModel
      : undefined

    // 提取 model
    const model =
      requestedVariantSelection?.baseModel ||
      requestedBaseModel ||
      modelDetailsVariantSelection?.baseModel ||
      modelDetailsBaseModel ||
      req.modelDetails?.modelId ||
      "claude-sonnet-4-20250514"

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
    let rootPath = ""
    const directories: string[] = []
    if (requestContext?.repositoryInfo?.length) {
      for (const repo of requestContext.repositoryInfo) {
        if (repo.workspaceUri) {
          // workspaceUri 格式为 "file:///path/to/project"
          const path = repo.workspaceUri.replace(/^file:\/\//, "")
          if (!rootPath) rootPath = path
          directories.push(path)
        }
      }
    }
    // 兜底：从 conversationState.previousWorkspaceUris 提取
    if (!rootPath && req.conversationState?.previousWorkspaceUris?.length) {
      for (const uri of req.conversationState.previousWorkspaceUris) {
        const path = uri.replace(/^file:\/\//, "")
        if (!rootPath) rootPath = path
        directories.push(path)
      }
    }
    // 兜底2：从 gitRepos[].path 提取（这是最可靠的来源）
    if (!rootPath && requestContext?.gitRepos?.length) {
      for (const git of requestContext.gitRepos) {
        if (git.path) {
          if (!rootPath) rootPath = git.path
          if (!directories.includes(git.path)) directories.push(git.path)
        }
      }
    }

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
    const contextTokenLimitFromState =
      req.conversationState?.tokenDetails &&
      req.conversationState.tokenDetails.maxTokens > 0
        ? req.conversationState.tokenDetails.maxTokens
        : undefined
    const contextTokenLimit =
      contextTokenLimitFromState || requestedContextTokenLimit

    if (contextTokenLimit || requestedMaxOutputTokens) {
      this.logger.log(
        `Token budget from protocol: contextLimit=${contextTokenLimit || "(none)"}, ` +
          `usedContext=${usedContextTokens || "(none)"}, maxOutput=${requestedMaxOutputTokens || "(none)"}`
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
    const modelMaxMode = req.modelDetails?.maxMode === true
    const requestedMaxMode = req.requestedModel?.maxMode === true
    const requestedVariantMaxMode = requestedVariantSelection?.maxMode === true
    const modelDetailsVariantMaxMode =
      modelDetailsVariantSelection?.maxMode === true
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

    if (thinkingLevel > 0) {
      this.logger.log(
        `Thinking enabled: level=${thinkingLevel} (thinkingDetails=${hasThinkingDetails}, ` +
          `modelMaxMode=${modelMaxMode}, requestedMaxMode=${requestedMaxMode}, requestedVariantMaxMode=${requestedVariantMaxMode}, modelDetailsVariantMaxMode=${modelDetailsVariantMaxMode}, ` +
          `requestedThinkingLevel=${requestedThinkingLevel ?? 0})`
      )
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
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools,
          useWeb,
          conversationId,
          projectContext: rootPath
            ? { rootPath, directories, files: [] }
            : undefined,
          cursorRules,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          requestContextEnv,
          isResumeAction: true,
          resumePendingToolCallIds:
            req.conversationState?.pendingToolCalls || [],
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
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      conversationId,
      projectContext: rootPath
        ? { rootPath, directories, files: [] }
        : undefined,
      cursorRules,
      cursorCommands: cursorCommands.length > 0 ? cursorCommands : undefined,
      customSystemPrompt: customSystemPrompt || undefined,
      contextTokenLimit,
      usedContextTokens,
      requestedMaxOutputTokens,
      requestedModelParameters,
      requestContextEnv,
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
