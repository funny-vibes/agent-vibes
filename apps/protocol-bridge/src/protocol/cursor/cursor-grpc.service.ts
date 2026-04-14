import { create, toBinary } from "@bufbuild/protobuf"
import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"
import type { KvServerMessage as KvStorageMessage } from "./kv-storage.service"

import {
  AgentMode,
  AgentServerMessageSchema,
  // New v2.6.13 ToolCall schemas
  AiAttributionArgsSchema,
  AiAttributionErrorSchema,
  type AiAttributionResult,
  AiAttributionResultSchema,
  AiAttributionSuccessSchema,
  AiAttributionToolCallSchema,
  // ToolCall Args
  ApplyAgentDiffArgsSchema,
  ApplyAgentDiffErrorSchema,
  ApplyAgentDiffResultSchema,
  ApplyAgentDiffSuccessSchema,
  ApplyAgentDiffToolCallSchema,
  AskQuestionArgsSchema,
  AskQuestionAsyncSchema,
  AskQuestionErrorSchema,
  AskQuestionRejectedSchema,
  type AskQuestionResult,
  AskQuestionResultSchema,
  AskQuestionSuccessSchema,
  AskQuestionToolCallSchema,
  AwaitArgsSchema,
  AwaitErrorSchema,
  type AwaitResult,
  AwaitResultSchema,
  AwaitSuccessSchema,
  AwaitTaskCompleteSchema,
  AwaitToolCallSchema,
  BackgroundShellSpawnArgsSchema,
  BlameByFilePathArgsSchema,
  BlameByFilePathErrorSchema,
  BlameByFilePathResultSchema,
  BlameByFilePathSuccessSchema,
  BlameByFilePathToolCallSchema,
  type CommandClassifierResult,
  CommandClassifierResultSchema,
  ComputerUseArgsSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ComputerUseSuccessSchema,
  ComputerUseToolCallSchema,
  // ConversationStateStructure
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  CreatePlanArgsSchema,
  CreatePlanErrorSchema,
  CreatePlanResultSchema,
  CreatePlanSuccessSchema,
  CreatePlanToolCallSchema,
  // PR Management
  CreatePrActionSchema,
  CursorRuleSchema,
  DeleteArgsSchema,
  DeleteErrorSchema,
  DeleteFileBusySchema,
  DeleteFileNotFoundSchema,
  DeleteNotFileSchema,
  DeletePermissionDeniedSchema,
  DeleteRejectedSchema,
  type DeleteResult,
  DeleteResultSchema,
  DeleteSuccessSchema,
  DeleteToolCallSchema,
  DiagnosticItemSchema,
  DiagnosticRangeSchema,
  DiagnosticsArgsSchema,
  EditArgsSchema,
  EditErrorSchema,
  EditFileNotFoundSchema,
  EditRejectedSchema,
  type EditResult,
  EditResultSchema,
  EditSuccessSchema,
  EditToolCallDeltaSchema,
  EditToolCallSchema,
  EditWritePermissionDeniedSchema,
  // Fetch/Search schemas (Cursor v2.6.13: ExaFetch→Fetch, ExaSearch→WebSearch)
  type ExecServerMessage,
  ExecServerMessageSchema,
  ExecuteHookArgsSchema,
  FetchArgsSchema,
  FetchErrorSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  FetchToolCallSchema,
  FileDiagnosticsSchema,
  FileStateStructureSchema,
  GenerateImageArgsSchema,
  GenerateImageErrorSchema,
  GenerateImageResultSchema,
  GenerateImageSuccessSchema,
  GenerateImageToolCallSchema,
  GetBlobArgsSchema,
  GetMcpToolsAgentResultSchema,
  GetMcpToolsArgsSchema,
  GetMcpToolsErrorSchema,
  GetMcpToolsSuccessSchema,
  GetMcpToolsToolCallSchema,
  GlobToolArgsSchema,
  GlobToolCallSchema,
  GlobToolErrorSchema,
  GlobToolResultSchema,
  GlobToolSuccessSchema,
  GrepArgsSchema,
  GrepErrorSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepToolCallSchema,
  HeartbeatUpdateSchema,
  type InteractionQuery,
  InteractionQuerySchema,
  type InteractionUpdate,
  InteractionUpdateSchema,
  // KV
  KvServerMessageSchema,
  ListMcpResourcesErrorSchema,
  ListMcpResourcesExecArgsSchema,
  type ListMcpResourcesExecResult,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesRejectedSchema,
  ListMcpResourcesSuccessSchema,
  ListMcpResourcesToolCallSchema,
  LsArgsSchema,
  type LsDirectoryTreeNode_File,
  LsDirectoryTreeNodeSchema,
  LsErrorSchema,
  LsRejectedSchema,
  type LsResult,
  LsResultSchema,
  LsSuccessSchema,
  LsTimeoutSchema,
  LsToolCallSchema,
  McpArgsSchema,
  McpAuthArgsSchema,
  McpAuthErrorSchema,
  McpAuthRejectedSchema,
  type McpAuthResult,
  McpAuthResultSchema,
  McpAuthSuccessSchema,
  McpAuthToolCallSchema,
  McpPermissionDeniedSchema,
  McpRejectedSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolErrorSchema,
  type McpToolResult,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  OutputLocationSchema,
  PartialToolCallUpdateSchema,
  PhaseSchema,
  PositionSchema,
  type PrManagementArgs,
  PrManagementArgsSchema,
  PrManagementErrorSchema,
  PrManagementRejectedSchema,
  type PrManagementResult,
  PrManagementResultSchema,
  PrManagementSuccessSchema,
  PrManagementToolCallSchema,
  ReadArgsSchema,
  ReadLintsToolArgsSchema,
  ReadLintsToolCallSchema,
  ReadLintsToolErrorSchema,
  ReadLintsToolResultSchema,
  ReadLintsToolSuccessSchema,
  ReadMcpResourceErrorSchema,
  ReadMcpResourceExecArgsSchema,
  type ReadMcpResourceExecResult,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceNotFoundSchema,
  ReadMcpResourceRejectedSchema,
  ReadMcpResourceSuccessSchema,
  ReadMcpResourceToolCallSchema,
  ReadRangeSchema,
  ReadTodosArgsSchema,
  ReadTodosErrorSchema,
  ReadTodosResultSchema,
  ReadTodosSuccessSchema,
  ReadTodosToolCallSchema,
  ReadToolArgsSchema,
  ReadToolCallSchema,
  ReadToolErrorSchema,
  ReadToolResultSchema,
  ReadToolSuccessSchema,
  RecordingMode,
  RecordScreenArgsSchema,
  RecordScreenDiscardSuccessSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RecordScreenSaveSuccessSchema,
  RecordScreenStartSuccessSchema,
  RecordScreenToolCallSchema,
  ReflectArgsSchema,
  ReflectErrorSchema,
  ReflectResultSchema,
  ReflectSuccessSchema,
  ReflectToolCallSchema,
  ReportBugArgsSchema,
  ReportBugErrorSchema,
  ReportBugfixResultsArgsSchema,
  ReportBugfixResultsErrorSchema,
  ReportBugfixResultsResultSchema,
  ReportBugfixResultsSuccessSchema,
  ReportBugfixResultsToolCallSchema,
  ReportBugResultSchema,
  ReportBugSuccessSchema,
  ReportBugToolCallSchema,
  SandboxPolicy_Type,
  SandboxPolicySchema,
  SemSearchToolArgsSchema,
  SemSearchToolCallSchema,
  SemSearchToolErrorSchema,
  SemSearchToolResultSchema,
  SemSearchToolSuccessSchema,
  SetActiveBranchArgsSchema,
  SetActiveBranchErrorSchema,
  SetActiveBranchResultSchema,
  SetActiveBranchSuccessSchema,
  SetActiveBranchToolCallSchema,
  SetBlobArgsSchema,
  SetupVmEnvironmentArgsSchema,
  SetupVmEnvironmentResultSchema,
  SetupVmEnvironmentSuccessSchema,
  SetupVmEnvironmentToolCallSchema,
  ShellAbortReason,
  // Shell
  ShellArgsSchema,
  ShellBackgroundReason,
  ShellCommandParsingResult_ExecutableCommandArgSchema,
  ShellCommandParsingResult_ExecutableCommandSchema,
  ShellCommandParsingResultSchema,
  ShellFailureSchema,
  ShellOutputDeltaUpdateSchema,
  ShellPermissionDeniedSchema,
  ShellRejectedSchema,
  type ShellResult,
  ShellResultSchema,
  ShellSpawnErrorSchema,
  ShellStreamExitSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  ShellTimeoutSchema,
  ShellToolCallDeltaSchema,
  ShellToolCallSchema,
  ShellToolCallStderrDeltaSchema,
  ShellToolCallStdoutDeltaSchema,
  // SpanContext
  SpanContextSchema,
  StartGrindExecutionArgsSchema,
  StartGrindExecutionErrorSchema,
  StartGrindExecutionResultSchema,
  StartGrindExecutionSuccessSchema,
  StartGrindExecutionToolCallSchema,
  StartGrindPlanningArgsSchema,
  StartGrindPlanningErrorSchema,
  StartGrindPlanningResultSchema,
  StartGrindPlanningSuccessSchema,
  StartGrindPlanningToolCallSchema,
  StepCompletedUpdateSchema,
  StepStartedUpdateSchema,
  StepTimingSchema,
  SubagentArgsSchema,
  SummaryCompletedUpdateSchema,
  SummaryStartedUpdateSchema,
  SummaryUpdateSchema,
  SwitchModeArgsSchema,
  SwitchModeErrorSchema,
  SwitchModeRejectedSchema,
  type SwitchModeResult,
  SwitchModeResultSchema,
  SwitchModeSuccessSchema,
  SwitchModeToolCallSchema,
  TaskArgsSchema,
  TaskErrorSchema,
  TaskResultSchema,
  TaskSuccessSchema,
  TaskToolCallDeltaSchema,
  TaskToolCallSchema,
  // InteractionUpdate sub-messages
  TextDeltaUpdateSchema,
  ThinkingCompletedUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TimeoutBehavior,
  // Todo & Phase
  TodoItemSchema,
  TokenDeltaUpdateSchema,
  type ToolCall,
  ToolCallCompletedUpdateSchema,
  type ToolCallDelta,
  ToolCallDeltaSchema,
  ToolCallDeltaUpdateSchema,
  // ToolCall
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TruncatedToolCallArgsSchema,
  TruncatedToolCallErrorSchema,
  TruncatedToolCallResultSchema,
  TruncatedToolCallSchema,
  TruncatedToolCallSuccessSchema,
  TurnEndedUpdateSchema,
  UpdatePrActionSchema,
  UpdateTodosArgsSchema,
  UpdateTodosErrorSchema,
  UpdateTodosResultSchema,
  UpdateTodosSuccessSchema,
  UpdateTodosToolCallSchema,
  UserMessageAppendedUpdateSchema,
  UserMessageSchema,
  WebFetchArgsSchema,
  WebFetchErrorSchema,
  WebFetchRejectedSchema,
  type WebFetchResult,
  WebFetchResultSchema,
  WebFetchSuccessSchema,
  WebFetchToolCallSchema,
  WebSearchArgsSchema,
  WebSearchErrorSchema,
  WebSearchRejectedSchema,
  type WebSearchResult,
  WebSearchResultSchema,
  WebSearchSuccessSchema,
  WebSearchToolCallSchema,
  WriteArgsSchema,
  WriteShellStdinArgsSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  WriteShellStdinSuccessSchema,
  WriteShellStdinToolCallSchema,
} from "../../gen/agent/v1_pb"
import {
  ListValueSchema,
  NullValue,
  StructSchema,
  type Value,
  ValueSchema,
} from "../../gen/google/protobuf/value_pb"
import { normalizeBugfixResultItems as normalizeBugfixResultItemsFromContract } from "./tools/bugfix-result-normalizer"
import { resolveCursorToolDefinitionKey } from "./tools/cursor-tool-mapper"
import { resolveMcpCallFields as resolveMcpCallFieldsFromContract } from "./tools/mcp-call-contract"

/**
 * Safely convert unknown value to string
 */
function safeString(value: unknown, defaultValue: string = ""): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return defaultValue
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (typeof value === "object") return JSON.stringify(value)
  return defaultValue
}

// ─── Protobuf OneOf type aliases ───────────────────────────────
type ToolCallOneOf = ToolCall["tool"]
type InteractionUpdateOneOf = InteractionUpdate["message"]
type InteractionQueryOneOf = InteractionQuery["query"]

/**
 * Parse unknown input into protobuf-compatible uint32.
 * Invalid / empty values fall back to a safe default instead of NaN.
 */
function safeUint32(value: unknown, defaultValue = 0): number {
  const clamp = (input: number): number => {
    if (!Number.isFinite(input)) return defaultValue
    const normalized = Math.floor(input)
    if (normalized < 0 || normalized > 0xffffffff) return defaultValue
    return normalized
  }

  if (typeof value === "number") return clamp(value)
  if (typeof value === "bigint") return clamp(Number(value))
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return defaultValue
    if (!/^\d+$/.test(trimmed)) return defaultValue
    return clamp(Number(trimmed))
  }

  if (value === null || value === undefined) return defaultValue
  return clamp(Number(value))
}

/**
 * Cursor exec protocol expects shell timeout in milliseconds.
 * We accept either seconds (small values) or milliseconds.
 */
function normalizeShellTimeoutMs(value: unknown, defaultMs = 30_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultMs
  }
  const normalized = Math.round(value)
  // Heuristic: <=120 is likely seconds from model/tool schema
  if (normalized <= 120) return normalized * 1000
  return normalized
}

function stripWrappingQuotes(token: string): string {
  if (token.length < 2) return token
  const first = token[0]
  const last = token[token.length - 1]
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return token.slice(1, -1)
  }
  return token
}

/**
 * Split command chain by unquoted separators (;, &&, ||, |, newlines).
 */
function splitShellCommandChain(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const next = i + 1 < command.length ? command[i + 1]! : ""

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\") {
      current += ch
      escaped = true
      continue
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      current += ch
      continue
    }

    if (!inSingle && !inDouble) {
      if (ch === "\n" || ch === ";") {
        const piece = current.trim()
        if (piece) parts.push(piece)
        current = ""
        continue
      }
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        const piece = current.trim()
        if (piece) parts.push(piece)
        current = ""
        i++
        continue
      }
      if (ch === "|") {
        const piece = current.trim()
        if (piece) parts.push(piece)
        current = ""
        continue
      }
    }

    current += ch
  }

  const tail = current.trim()
  if (tail) parts.push(tail)
  return parts
}

function splitShellTokens(segment: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === "\\") {
      current += ch
      escaped = true
      continue
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      current += ch
      continue
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += ch
  }

  if (current) tokens.push(current)
  return tokens
}

function buildShellParsingMetadata(command: string) {
  const commandText = command.trim()
  const segments = splitShellCommandChain(commandText)
  const executableCommands = segments
    .map((segment) => {
      const tokens = splitShellTokens(segment)
      if (tokens.length === 0) return null

      const name = stripWrappingQuotes(tokens[0]!)
      const args = tokens.slice(1).map((token) =>
        create(ShellCommandParsingResult_ExecutableCommandArgSchema, {
          type: "word",
          value: stripWrappingQuotes(token),
        })
      )

      return create(ShellCommandParsingResult_ExecutableCommandSchema, {
        name,
        args,
        fullText: segment,
      })
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v))

  const hasInputRedirect = /(^|[^\\])(<|<<)/.test(commandText)
  const hasOutputRedirect = /(^|[^\\])(>|>>|1>|1>>|2>|2>>|&>)/.test(commandText)
  const hasCommandSubstitution = /`[^`]*`|\$\(/.test(commandText)

  return {
    simpleCommands: executableCommands.map((c) => c.name).filter(Boolean),
    hasInputRedirect,
    hasOutputRedirect,
    parsingResult: create(ShellCommandParsingResultSchema, {
      parsingFailed: executableCommands.length === 0,
      executableCommands,
      hasRedirects: hasInputRedirect || hasOutputRedirect,
      hasCommandSubstitution,
    }),
  }
}

/**
 * Tool parameter interface definition
 */
interface ReadFileArgs {
  path?: string
  start_line?: number
  end_line?: number
}

interface ListDirArgs {
  path?: string
  recursive?: boolean
}

interface GrepArgs {
  query?: string
  pattern?: string
  Query?: string
  path?: string
  SearchPath?: string
  searchPath?: string
  search_path?: string
  glob?: string
  includes?: string[]
  Includes?: string[]
  output_mode?: string
  outputMode?: string
  matchPerLine?: boolean
  match_per_line?: boolean
  MatchPerLine?: boolean
  caseInsensitive?: boolean
  case_insensitive?: boolean
  CaseInsensitive?: boolean
  isRegex?: boolean
  is_regex?: boolean
  IsRegex?: boolean
  head_limit?: number
  headLimit?: number
  HeadLimit?: number
  offset?: number
  Offset?: number
  type?: string
  case_sensitive?: boolean
}

interface GlobArgs {
  pattern?: string
  path?: string
  targetDirectory?: string
  globPattern?: string
}

interface ShellArgs {
  command?: string
  cwd?: string
  working_directory?: string
  workingDirectory?: string
  timeout?: number
}

interface EditFileArgs {
  path?: string
  search?: string
  old_text?: string
  replace?: string
  new_text?: string
}

interface DeleteFileArgs {
  path?: string
}

interface DiagnosticsArgs {
  paths?: string[]
  path?: string
  toolCallId?: string
}

interface McpArgs {
  serverName?: string
  server_name?: string
  name?: string
  toolName?: string
  tool_name?: string
  arguments?: Record<string, unknown>
  args?: Record<string, unknown>
  providerIdentifier?: string
  provider_identifier?: string
  toolCallId?: string
}

interface BackgroundShellSpawnArgs {
  command?: string
  cwd?: string
  working_directory?: string
  workingDirectory?: string
  enableWriteShellStdinTool?: boolean
  enable_write_shell_stdin_tool?: boolean
  toolCallId?: string
}

interface ListMcpResourcesArgs {
  serverName?: string
  server?: string
  server_name?: string
  toolCallId?: string
}

interface ReadMcpResourceArgs {
  serverName?: string
  server?: string
  server_name?: string
  uri?: string
  downloadPath?: string
  download_path?: string
  toolCallId?: string
}

interface FetchArgs {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: string
  toolCallId?: string
}

interface RecordScreenArgs {
  mode?: string | number
  saveAsFilename?: string
  save_as_filename?: string
  duration?: number
  toolCallId?: string
}

interface ComputerUseArgs {
  action?: string
  actions?: unknown[]
  coordinate?: [number, number]
  text?: string
  toolCallId?: string
}

interface WriteShellStdinArgs {
  shellId?: string | number
  shell_id?: string | number
  data?: string
  chars?: string
  toolCallId?: string
}

interface ExecuteHookArgs {
  hookName?: string
  hookArgs?: Record<string, unknown>
  toolCallId?: string
}

type ToolArgs =
  | ReadFileArgs
  | ListDirArgs
  | GrepArgs
  | GlobArgs
  | ShellArgs
  | EditFileArgs
  | DeleteFileArgs
  | DiagnosticsArgs
  | McpArgs
  | BackgroundShellSpawnArgs
  | ListMcpResourcesArgs
  | ReadMcpResourceArgs
  | FetchArgs
  | RecordScreenArgs
  | ComputerUseArgs
  | WriteShellStdinArgs
  | ExecuteHookArgs

type ToolFamily =
  | "get_mcp_tools"
  | "read_mcp_resource"
  | "list_mcp_resources"
  | "read_lints"
  | "fix_lints"
  | "read_todos"
  | "update_todos"
  | "apply_agent_diff"
  | "write_shell_stdin"
  | "background_shell_spawn"
  | "setup_vm_environment"
  | "start_grind_execution"
  | "start_grind_planning"
  | "report_bugfix_results"
  | "generate_image"
  | "record_screen"
  | "computer_use"
  | "web_search"
  | "web_fetch"
  | "exa_search"
  | "exa_fetch"
  | "ask_question"
  | "switch_mode"
  | "create_plan"
  | "sem_search"
  | "truncated"
  | "reflect"
  | "read"
  | "edit"
  | "ls"
  | "delete"
  | "grep"
  | "glob"
  | "fetch"
  | "mcp"
  | "mcp_auth"
  | "task"
  | "shell"
  | "execute_hook"
  | "await"
  | "ai_attribution"
  | "pr_management"
  | "blame_by_file_path"
  | "report_bug"
  | "set_active_branch"
  | "unknown"

type ToolResultProjectionStatus =
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

interface ToolCompletionExtraData {
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
      lineStart?: number
      lineEnd?: number
    }
    terminalsFolder?: string
    timeoutBehavior?: number
    hardTimeout?: number
    requestedSandboxPolicy?: { type?: unknown } | null
    isBackground?: boolean
    description?: string
    classifierResult?: Record<string, unknown> | CommandClassifierResult
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
  toolResultState?: {
    status: ToolResultProjectionStatus
    message?: string
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
  // New v2.6.13
  awaitResult?: {
    runtimeMs?: number
    outputFilePath?: string
    outputLength?: number
    exitCode?: number
  }
  prResult?: {
    prUrl?: string
    prNumber?: number
  }
  aiAttributionResult?: {
    filePaths?: string[]
    commitHashes?: string[]
    startLine?: number
    endLine?: number
    outputMode?: string
    maxCommits?: number
    includeLineRanges?: boolean
  }
}

/**
 * Cursor gRPC Service
 * Build protobuf messages using @bufbuild/protobuf create/toBinary
 * Replaces the legacy 3277-line manual Buffer implementation
 */
@Injectable()
export class CursorGrpcService {
  private readonly logger = new Logger(CursorGrpcService.name)
  private readonly execDispatchableFamilies: ReadonlySet<ToolFamily> = new Set([
    "read_mcp_resource",
    "list_mcp_resources",
    "read_lints",
    "fetch",
    "generate_image",
    "record_screen",
    "computer_use",
    "write_shell_stdin",
    "background_shell_spawn",
    "read",
    "edit",
    "ls",
    "delete",
    "grep",
    "mcp",
    "shell",
    "execute_hook",
  ])
  private readonly protocolInlineOnlyFamilies: ReadonlySet<ToolFamily> =
    new Set([
      "get_mcp_tools",
      "fix_lints",
      "read_todos",
      "apply_agent_diff",
      "sem_search",
      "setup_vm_environment",
      "web_fetch",
      "web_search",
      "exa_search",
      "exa_fetch",
      "task",
      "ask_question",
      "switch_mode",
      "reflect",
      "start_grind_execution",
      "start_grind_planning",
      "report_bugfix_results",
      "truncated",
      // New v2.6.13
      "await",
      "ai_attribution",
      "mcp_auth",
      "pr_management",
    ])

  // Active blob ID list (for KV storage)
  messageBlobIds?: string[]

  // ─── Helper Methods ─────────────────────────────────────────

  /**
   * Serialize to Buffer and add ConnectRPC envelope (5-byte header)
   */
  addConnectEnvelope(message: Uint8Array | Buffer): Buffer {
    const data = Buffer.from(message)
    const header = Buffer.alloc(5)
    header[0] = 0x00 // flags: no compression
    header.writeUInt32BE(data.length, 1)
    return Buffer.concat([header, data])
  }

  /**
   * Build SpanContext (for tracing)
   */
  private buildSpanContext() {
    return create(SpanContextSchema, {
      traceId: crypto.randomBytes(16).toString("hex"),
      spanId: crypto.randomBytes(8).toString("hex"),
      traceFlags: 0,
    })
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => safeString(item).trim())
      .filter((item) => item.length > 0)
  }

  private parseRecordScreenMode(value: unknown): RecordingMode {
    const numeric = Number(value)
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 3) {
      return numeric as RecordingMode
    }
    const normalized = safeString(value).trim().toLowerCase()
    if (
      normalized === "save" ||
      normalized === "save_recording" ||
      normalized === "recording_mode_save_recording" ||
      normalized === "save-recording" ||
      normalized === "save recording"
    ) {
      return RecordingMode.SAVE_RECORDING
    }
    if (
      normalized === "discard" ||
      normalized === "discard_recording" ||
      normalized === "recording_mode_discard_recording" ||
      normalized === "discard-recording" ||
      normalized === "discard recording"
    ) {
      return RecordingMode.DISCARD_RECORDING
    }
    if (
      normalized === "start" ||
      normalized === "start_recording" ||
      normalized === "recording_mode_start_recording" ||
      normalized === "start-recording" ||
      normalized === "start recording"
    ) {
      return RecordingMode.START_RECORDING
    }
    return RecordingMode.START_RECORDING
  }

  private toProtoValue(input: unknown, depth = 0): Value {
    if (depth > 8) {
      return create(ValueSchema, {
        kind: { case: "stringValue", value: safeString(input) },
      })
    }
    if (input === null || input === undefined) {
      return create(ValueSchema, {
        kind: { case: "nullValue", value: NullValue.NULL_VALUE },
      })
    }
    if (typeof input === "string") {
      return create(ValueSchema, {
        kind: { case: "stringValue", value: input },
      })
    }
    if (typeof input === "number") {
      return create(ValueSchema, {
        kind: {
          case: "numberValue",
          value: Number.isFinite(input) ? input : 0,
        },
      })
    }
    if (typeof input === "boolean") {
      return create(ValueSchema, {
        kind: { case: "boolValue", value: input },
      })
    }
    if (Array.isArray(input)) {
      return create(ValueSchema, {
        kind: {
          case: "listValue",
          value: create(ListValueSchema, {
            values: input.map((item) => this.toProtoValue(item, depth + 1)),
          }),
        },
      })
    }
    if (typeof input === "object") {
      const fields: Record<string, Value> = {}
      for (const [key, value] of Object.entries(
        input as Record<string, unknown>
      )) {
        fields[key] = this.toProtoValue(value, depth + 1)
      }
      return create(ValueSchema, {
        kind: {
          case: "structValue",
          value: create(StructSchema, { fields }),
        },
      })
    }
    return create(ValueSchema, {
      kind: { case: "stringValue", value: safeString(input) },
    })
  }

  private toProtoValueMap(input: unknown): Record<string, Value> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {}
    }
    const out: Record<string, Value> = {}
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>
    )) {
      out[key] = this.toProtoValue(value)
    }
    return out
  }

  // ─── InteractionUpdate Wrappers ─────────────────────────────

  /**
   * Wrap InteractionUpdate as AgentServerMessage
   */
  private wrapInteractionUpdate(
    updateCase: string,
    updateValue: unknown
  ): Buffer {
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate" as const,
        value: create(InteractionUpdateSchema, {
          message: {
            case: updateCase,
            value: updateValue,
          } as InteractionUpdateOneOf,
        }),
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, msg))
  }

  /**
   * Wrap InteractionQuery as AgentServerMessage
   */
  createInteractionQueryResponse(
    queryId: number,
    queryCase: string,
    queryValue: unknown
  ): Buffer {
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery" as const,
        value: create(InteractionQuerySchema, {
          id: queryId,
          query: {
            case: queryCase,
            value: queryValue,
          } as InteractionQueryOneOf,
        }),
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, msg))
  }

  // ─── Text / Thinking Responses ──────────────────────────────

  /**
   * Create Agent text response
   */
  createAgentTextResponse(text: string): Buffer {
    return this.wrapInteractionUpdate(
      "textDelta",
      create(TextDeltaUpdateSchema, { text })
    )
  }

  /**
   * Create Thinking Delta response
   */
  createThinkingDeltaResponse(thinking: string): Buffer {
    return this.wrapInteractionUpdate(
      "thinkingDelta",
      create(ThinkingDeltaUpdateSchema, {
        text: thinking,
        thinkingStyle: 1, // THINKING_STYLE_DEFAULT
      })
    )
  }

  /**
   * Create Thinking completed response
   */
  createThinkingCompletedResponse(thinkingDurationMs: number = 0): Buffer {
    return this.wrapInteractionUpdate(
      "thinkingCompleted",
      create(ThinkingCompletedUpdateSchema, { thinkingDurationMs })
    )
  }

  /**
   * Create SummaryStarted response
   */
  createSummaryStartedResponse(): Buffer {
    return this.wrapInteractionUpdate(
      "summaryStarted",
      create(SummaryStartedUpdateSchema, {})
    )
  }

  /**
   * Create Summary Delta response
   */
  createSummaryResponse(summary: string): Buffer {
    return this.wrapInteractionUpdate(
      "summary",
      create(SummaryUpdateSchema, { summary })
    )
  }

  /**
   * Create SummaryCompleted response
   */
  createSummaryCompletedResponse(hookMessage?: string): Buffer {
    return this.wrapInteractionUpdate(
      "summaryCompleted",
      create(SummaryCompletedUpdateSchema, {
        hookMessage: safeString(hookMessage) || undefined,
      })
    )
  }

  /**
   * Create UserMessageAppended response
   */
  createUserMessageAppendedResponse(
    text: string,
    messageId: string,
    mode: AgentMode = AgentMode.AGENT
  ): Buffer {
    return this.wrapInteractionUpdate(
      "userMessageAppended",
      create(UserMessageAppendedUpdateSchema, {
        userMessage: create(UserMessageSchema, {
          text,
          messageId,
          mode,
          conversationStateBlobId: new Uint8Array(),
        }),
      })
    )
  }

  // ─── Token / Heartbeat / TurnEnded ─────────────────────────

  /**
   * Create Token Delta response
   */
  createTokenDeltaResponse(inputTokens: number, outputTokens: number): Buffer {
    // TokenDeltaUpdate has a single tokens field, use sum
    return this.wrapInteractionUpdate(
      "tokenDelta",
      create(TokenDeltaUpdateSchema, {
        tokens: inputTokens + outputTokens,
      })
    )
  }

  /**
   * Create heartbeat response (InteractionUpdate)
   */
  createHeartbeatResponse(): Buffer {
    return this.wrapInteractionUpdate(
      "heartbeat",
      create(HeartbeatUpdateSchema, {})
    )
  }

  /**
   * Create TurnEnded response (Agent mode end signal)
   */
  createAgentTurnEndedResponse(): Buffer {
    return this.wrapInteractionUpdate(
      "turnEnded",
      create(TurnEndedUpdateSchema, {})
    )
  }

  // ─── Server Heartbeat ─────────────

  /**
   * Create ServerHeartbeat response
   * AgentServerMessage has no serverHeartbeat case, use InteractionUpdate.heartbeat
   */
  createServerHeartbeatResponse(): Buffer {
    return this.createHeartbeatResponse()
  }

  // ─── Step Started / Completed ──────────────────────────────

  /**
   * Create StepStarted response
   */
  createStepStartedResponse(stepId: number): Buffer {
    return this.wrapInteractionUpdate(
      "stepStarted",
      create(StepStartedUpdateSchema, { stepId: BigInt(stepId) })
    )
  }

  /**
   * Create StepCompleted response
   */
  createStepCompletedResponse(stepId: number, durationMs: number = 0): Buffer {
    return this.wrapInteractionUpdate(
      "stepCompleted",
      create(StepCompletedUpdateSchema, {
        stepId: BigInt(stepId),
        stepDurationMs: BigInt(durationMs),
      })
    )
  }

  // ─── Shell Output ──────────────────────────────────────────

  /**
   * Create ShellOutput stdout response
   */
  createShellOutputStdoutResponse(data: string): Buffer {
    return this.wrapInteractionUpdate(
      "shellOutputDelta",
      create(ShellOutputDeltaUpdateSchema, {
        event: {
          case: "stdout" as const,
          value: create(ShellStreamStdoutSchema, { data }),
        },
      })
    )
  }

  /**
   * Create ShellOutput stderr response
   */
  createShellOutputStderrResponse(data: string): Buffer {
    return this.wrapInteractionUpdate(
      "shellOutputDelta",
      create(ShellOutputDeltaUpdateSchema, {
        event: {
          case: "stderr" as const,
          value: create(ShellStreamStderrSchema, { data }),
        },
      })
    )
  }

  /**
   * Create ShellOutput exit response
   */
  createShellOutputExitResponse(
    code: number = 0,
    aborted: boolean = false,
    cwd: string = "",
    options?: {
      outputLocation?: unknown
      abortReason?: unknown
      localExecutionTimeMs?: unknown
    }
  ): Buffer {
    return this.wrapInteractionUpdate(
      "shellOutputDelta",
      create(ShellOutputDeltaUpdateSchema, {
        event: {
          case: "exit" as const,
          value: create(ShellStreamExitSchema, {
            code,
            aborted,
            cwd,
            outputLocation: this.normalizeOutputLocation(
              options?.outputLocation
            ),
            abortReason: this.normalizeShellAbortReason(options?.abortReason),
            localExecutionTimeMs: this.parseOptionalNonNegativeInt(
              options?.localExecutionTimeMs
            ),
          }),
        },
      })
    )
  }

  /**
   * Create ShellOutput start response
   */
  createShellOutputStartResponse(
    sandboxPolicy?: { type?: unknown } | null
  ): Buffer {
    const rawType = sandboxPolicy?.type
    const parsedType = Number(rawType)
    const resolvedSandboxPolicy =
      Number.isFinite(parsedType) && parsedType >= 0
        ? create(SandboxPolicySchema, {
            type: Math.floor(parsedType) as SandboxPolicy_Type,
          })
        : create(SandboxPolicySchema, {
            type: SandboxPolicy_Type.WORKSPACE_READWRITE,
          })

    return this.wrapInteractionUpdate(
      "shellOutputDelta",
      create(ShellOutputDeltaUpdateSchema, {
        event: {
          case: "start" as const,
          value: create(ShellStreamStartSchema, {
            sandboxPolicy: resolvedSandboxPolicy,
          }),
        },
      })
    )
  }

  /**
   * @deprecated Use createShellOutputStdoutResponse / createShellOutputStderrResponse
   */
  createShellOutputDeltaResponse(
    stdout: string = "",
    stderr: string = ""
  ): Buffer {
    if (stderr) {
      return this.createShellOutputStderrResponse(stderr)
    }
    return this.createShellOutputStdoutResponse(stdout)
  }

  // ─── ToolCall Started / Completed / Partial ────────────────

  /**
   * Create ToolCallStarted response
   */
  createToolCallStartedResponse(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    toolFamilyHint?: ToolFamily,
    modelCallId: string = ""
  ): Buffer {
    return this.wrapInteractionUpdate(
      "toolCallStarted",
      create(ToolCallStartedUpdateSchema, {
        callId,
        toolCall: this.buildToolCallV2(toolName, callId, args, toolFamilyHint),
        modelCallId,
      })
    )
  }

  /**
   * Create ToolCallCompleted response
   */
  createToolCallCompletedResponse(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: string = "",
    toolFamilyHint?: ToolFamily,
    modelCallId: string = "",
    extraData?: ToolCompletionExtraData
  ): Buffer {
    return this.wrapInteractionUpdate(
      "toolCallCompleted",
      create(ToolCallCompletedUpdateSchema, {
        callId,
        toolCall: this.buildToolCallV2WithResult(
          toolName,
          callId,
          args,
          result,
          extraData,
          toolFamilyHint
        ),
        modelCallId,
      })
    )
  }

  /**
   * Create empty PartialToolCall response (initial notification)
   */
  createEmptyPartialToolCallResponse(
    callId: string,
    toolName: string,
    modelCallId: string = ""
  ): Buffer {
    return this.wrapInteractionUpdate(
      "partialToolCall",
      create(PartialToolCallUpdateSchema, {
        callId,
        toolCall: this.buildEmptyToolCallV2(toolName),
        argsTextDelta: "",
        modelCallId,
      })
    )
  }

  /**
   * Create PartialToolCall response (with argument update)
   */
  createPartialToolCallResponse(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    argsTextDelta: string = "",
    modelCallId: string = ""
  ): Buffer {
    return this.wrapInteractionUpdate(
      "partialToolCall",
      create(PartialToolCallUpdateSchema, {
        callId,
        toolCall: this.buildToolCallV2(toolName, callId, args),
        argsTextDelta,
        modelCallId,
      })
    )
  }

  /**
   * Create PartialToolCall delta response (incremental argument streaming)
   * Only sends args_text_delta, without the full tool_call
   */
  createPartialToolCallDeltaResponse(
    callId: string,
    toolName: string,
    argsTextDelta: string,
    modelCallId: string = ""
  ): Buffer {
    return this.wrapInteractionUpdate(
      "partialToolCall",
      create(PartialToolCallUpdateSchema, {
        callId,
        toolCall: this.buildEmptyToolCallV2(toolName),
        argsTextDelta,
        modelCallId,
      })
    )
  }

  /**
   * Create ToolCallDelta response
   * Populates shellToolCallDelta / editToolCallDelta based on deltaType
   */
  createToolCallDeltaResponse(
    callId: string,
    _toolName: string,
    deltaType: "stdout" | "stderr" | "progress" | "stream_content",
    deltaContent: string,
    modelCallId?: string
  ): Buffer {
    // Build the appropriate ToolCallDelta based on deltaType
    let toolCallDelta: ToolCallDelta | undefined
    if (deltaType === "stdout") {
      toolCallDelta = create(ToolCallDeltaSchema, {
        delta: {
          case: "shellToolCallDelta" as const,
          value: create(ShellToolCallDeltaSchema, {
            delta: {
              case: "stdout" as const,
              value: create(ShellToolCallStdoutDeltaSchema, {
                content: deltaContent,
              }),
            },
          }),
        },
      })
    } else if (deltaType === "stderr") {
      toolCallDelta = create(ToolCallDeltaSchema, {
        delta: {
          case: "shellToolCallDelta" as const,
          value: create(ShellToolCallDeltaSchema, {
            delta: {
              case: "stderr" as const,
              value: create(ShellToolCallStderrDeltaSchema, {
                content: deltaContent,
              }),
            },
          }),
        },
      })
    } else if (deltaType === "stream_content") {
      toolCallDelta = create(ToolCallDeltaSchema, {
        delta: {
          case: "editToolCallDelta" as const,
          value: create(EditToolCallDeltaSchema, {
            streamContentDelta: deltaContent,
          }),
        },
      })
    } else if (deltaType === "progress") {
      toolCallDelta = create(ToolCallDeltaSchema, {
        delta: {
          case: "taskToolCallDelta" as const,
          value: create(TaskToolCallDeltaSchema, {
            interactionUpdate: create(InteractionUpdateSchema, {
              message: {
                case: "textDelta" as const,
                value: create(TextDeltaUpdateSchema, {
                  text: deltaContent,
                }),
              },
            }),
          }),
        },
      })
    }

    if (!toolCallDelta) {
      this.logger.warn(
        `Unsupported ToolCallDelta type: ${deltaType}, callId=${callId}`
      )
      return Buffer.alloc(0)
    }

    return this.wrapInteractionUpdate(
      "toolCallDelta",
      create(ToolCallDeltaUpdateSchema, {
        callId,
        toolCallDelta,
        modelCallId: modelCallId || "",
      })
    )
  }

  // ─── ExecServerMessage (Agent tool call dispatch) ────────────

  /**
   * 创建 Agent Tool Call 响应（ExecServerMessage）
   */
  createAgentToolCallResponse(
    toolName: string,
    toolCallId: string,
    args: ToolArgs,
    execIdNumber: number = 1
  ): Buffer {
    const inlineOnlyToolCase = this.getProtocolInlineOnlyToolCase(toolName)
    if (inlineOnlyToolCase) {
      const message = `Tool "${toolName}" maps to ${inlineOnlyToolCase} and must not be encoded as ExecServerMessage`
      this.logger.error(message)
      throw new Error(message)
    }

    if (!this.isExecDispatchableTool(toolName)) {
      const message = `Tool "${toolName}" is not Exec-dispatchable and cannot be encoded as ExecServerMessage`
      this.logger.error(message)
      throw new Error(message)
    }

    // Keep exec_id stable with toolCallId so ExecClientMessage can be matched reliably.
    const execId = toolCallId
    const execMsg = this.buildExecServerMessage(
      toolName,
      args,
      execIdNumber,
      toolCallId,
      execId
    )
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, execMsg))
  }

  /**
   * 创建 Edit tool 的 ReadArgs ExecServerMessage
   * 串行协议第一步：发送 readArgs 让 Cursor 读取文件当前内容
   */
  createReadExecMessage(
    toolCallId: string,
    path: string,
    execIdNumber: number = 1
  ): Buffer {
    const execId = toolCallId
    const readMsg = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage" as const,
        value: create(ExecServerMessageSchema, {
          id: execIdNumber,
          execId,
          spanContext: this.buildSpanContext(),
          message: {
            case: "readArgs" as const,
            value: create(ReadArgsSchema, {
              path,
              toolCallId,
            }),
          },
        }),
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, readMsg))
  }

  /**
   * 创建 Edit tool 的 WriteArgs ExecServerMessage
   * 串行协议第二步：收到 read_result 后发送 writeArgs 让 Cursor 写入新内容
   */
  createWriteExecMessage(
    toolCallId: string,
    path: string,
    newContent: string,
    execIdNumber: number = 2
  ): Buffer {
    const execId = toolCallId
    const writeMsg = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage" as const,
        value: create(ExecServerMessageSchema, {
          id: execIdNumber,
          execId,
          spanContext: this.buildSpanContext(),
          message: {
            case: "writeArgs" as const,
            value: create(WriteArgsSchema, {
              path,
              fileText: newContent,
              toolCallId,
              returnFileContentAfterWrite: false,
            }),
          },
        }),
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, writeMsg))
  }

  /**
   * 创建 Edit tool 两步消息（先 read 再 write）
   * @deprecated 使用 createReadExecMessage + createWriteExecMessage 串行发送
   */
  createEditToolExecMessages(
    toolCallId: string,
    path: string,
    newContent: string
  ): Buffer[] {
    return [
      this.createReadExecMessage(toolCallId, path),
      this.createWriteExecMessage(toolCallId, path, newContent),
    ]
  }

  private normalizeToolName(toolName: string): string {
    return toolName.toLowerCase().replace(/[^a-z0-9]+/g, "")
  }

  private detectToolFamily(toolName: string): ToolFamily {
    const definitionKey = resolveCursorToolDefinitionKey(toolName)
    if (definitionKey) {
      switch (definitionKey) {
        case "CLIENT_SIDE_TOOL_V2_READ_FILE":
        case "CLIENT_SIDE_TOOL_V2_READ_FILE_V2":
        case "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES":
        case "CLIENT_SIDE_TOOL_V2_FETCH_RULES":
          return "read"
        case "CLIENT_SIDE_TOOL_V2_EDIT_FILE":
        case "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2":
          return "edit"
        case "CLIENT_SIDE_TOOL_V2_LIST_DIR":
        case "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2":
        case "CLIENT_SIDE_TOOL_V2_READ_PROJECT":
          return "ls"
        case "CLIENT_SIDE_TOOL_V2_DELETE_FILE":
          return "delete"
        case "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH":
        case "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH":
          return "grep"
        case "CLIENT_SIDE_TOOL_V2_FILE_SEARCH":
        case "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH":
          return "glob"
        case "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2":
          return "shell"
        case "CLIENT_SIDE_TOOL_V2_BACKGROUND_SHELL_SPAWN":
          return "background_shell_spawn"
        case "CLIENT_SIDE_TOOL_V2_MCP":
        case "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL":
          return "mcp"
        case "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES":
          return "list_mcp_resources"
        case "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE":
          return "read_mcp_resource"
        case "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS":
          return "get_mcp_tools"
        case "CLIENT_SIDE_TOOL_V2_DIAGNOSTICS":
        case "CLIENT_SIDE_TOOL_V2_READ_LINTS":
          return "read_lints"
        case "CLIENT_SIDE_TOOL_V2_FIX_LINTS":
          return "fix_lints"
        case "CLIENT_SIDE_TOOL_V2_WEB_SEARCH":
        case "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE":
          return "web_search"
        case "CLIENT_SIDE_TOOL_V2_WEB_FETCH":
        case "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST":
          return "web_fetch"
        case "CLIENT_SIDE_TOOL_V2_EXA_SEARCH":
          return "exa_search"
        case "CLIENT_SIDE_TOOL_V2_EXA_FETCH":
          return "exa_fetch"
        case "CLIENT_SIDE_TOOL_V2_ASK_QUESTION":
        case "CLIENT_SIDE_TOOL_V2_ASK_FOLLOWUP_QUESTION":
          return "ask_question"
        case "CLIENT_SIDE_TOOL_V2_CREATE_PLAN":
          return "create_plan"
        case "CLIENT_SIDE_TOOL_V2_SWITCH_MODE":
          return "switch_mode"
        case "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL":
        case "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH":
        case "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS":
        case "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION":
          return "sem_search"
        case "CLIENT_SIDE_TOOL_V2_FETCH":
          return "fetch"
        case "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN":
          return "record_screen"
        case "CLIENT_SIDE_TOOL_V2_COMPUTER_USE":
          return "computer_use"
        case "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN":
          return "write_shell_stdin"
        case "CLIENT_SIDE_TOOL_V2_TASK":
        case "CLIENT_SIDE_TOOL_V2_TASK_V2":
          return "task"
        case "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP":
        case "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT":
          return "truncated"
        case "CLIENT_SIDE_TOOL_V2_AWAIT_TASK":
          return "await"
        case "CLIENT_SIDE_TOOL_V2_TODO_READ":
          return "read_todos"
        case "CLIENT_SIDE_TOOL_V2_TODO_WRITE":
          return "update_todos"
        case "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF":
        case "CLIENT_SIDE_TOOL_V2_REAPPLY":
          return "apply_agent_diff"
        case "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE":
        case "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM":
          return "generate_image"
        case "CLIENT_SIDE_TOOL_V2_SETUP_VM_ENVIRONMENT":
          return "setup_vm_environment"
        case "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS":
          return "report_bugfix_results"
        case "CLIENT_SIDE_TOOL_V2_START_GRIND_EXECUTION":
          return "start_grind_execution"
        case "CLIENT_SIDE_TOOL_V2_START_GRIND_PLANNING":
          return "start_grind_planning"
        case "CLIENT_SIDE_TOOL_V2_REFLECT":
          return "reflect"
      }
    }

    const normalized = this.normalizeToolName(toolName)

    if (normalized.includes("readsemsearchfiles")) return "read"
    if (normalized.includes("reapply")) return "apply_agent_diff"
    if (normalized.includes("fetchrules")) return "read"
    if (normalized.includes("searchsymbols")) return "sem_search"
    if (normalized.includes("backgroundcomposerfollowup")) return "truncated"
    if (normalized.includes("knowledgebase")) return "web_search"
    if (normalized.includes("fetchpullrequest")) return "web_fetch"
    if (normalized.includes("creatediagram")) return "generate_image"
    if (normalized.includes("gotodefinition")) return "sem_search"
    if (normalized.includes("awaittask")) return "await"
    if (normalized.includes("readproject")) return "ls"
    if (normalized.includes("updateproject")) return "truncated"

    if (
      normalized.includes("readmcpresource") ||
      normalized.includes("readmcp")
    ) {
      return "read_mcp_resource"
    }
    if (
      normalized.includes("listmcpresources") ||
      normalized.includes("listmcp")
    ) {
      return "list_mcp_resources"
    }
    if (normalized.includes("getmcptools")) {
      return "get_mcp_tools"
    }
    if (
      normalized.includes("readlints") ||
      normalized.includes("diagnostics")
    ) {
      return "read_lints"
    }
    if (normalized.includes("fixlints")) return "fix_lints"
    if (normalized.includes("readtodos")) return "read_todos"
    if (normalized.includes("updatetodos")) return "update_todos"
    if (normalized.includes("applyagentdiff")) return "apply_agent_diff"
    if (normalized.includes("writeshellstdin")) return "write_shell_stdin"
    if (normalized.includes("backgroundshellspawn"))
      return "background_shell_spawn"
    if (
      normalized.includes("setupvmenvironment") ||
      normalized.includes("setupvm")
    ) {
      return "setup_vm_environment"
    }
    if (normalized.includes("startgrindexecution"))
      return "start_grind_execution"
    if (normalized.includes("startgrindplanning")) return "start_grind_planning"
    if (
      normalized.includes("reportbugfixresults") ||
      normalized.includes("reportbugfix")
    ) {
      return "report_bugfix_results"
    }
    if (normalized.includes("generateimage")) return "generate_image"
    if (normalized.includes("recordscreen")) return "record_screen"
    if (normalized.includes("computeruse")) return "computer_use"
    if (normalized.includes("websearch")) return "web_search"
    if (normalized === "searchweb") return "web_search"
    if (normalized.includes("webfetch")) return "web_fetch"
    if (normalized === "readurlcontent" || normalized === "viewcontentchunk") {
      return "web_fetch"
    }
    if (normalized.includes("deepsearch")) return "sem_search"
    if (normalized.includes("exasearch")) return "exa_search"
    if (normalized.includes("exafetch")) return "exa_fetch"
    // New v2.6.13 tools
    if (normalized.includes("await")) return "await"
    if (
      normalized.includes("aiattribution") ||
      normalized.includes("ai_attribution")
    )
      return "ai_attribution"
    if (normalized.includes("mcpauth") || normalized.includes("mcp_auth"))
      return "mcp_auth"
    if (
      normalized.includes("prmanagement") ||
      normalized.includes("pr_management") ||
      normalized.includes("createpr") ||
      normalized.includes("create_pr")
    )
      return "pr_management"
    if (
      normalized.includes("blamebyfilepath") ||
      normalized.includes("blame_by_file_path")
    )
      return "blame_by_file_path"
    if (normalized.includes("reportbug") || normalized.includes("report_bug")) {
      // Distinguish report_bug from report_bugfix_results
      if (
        normalized.includes("bugfix") ||
        normalized.includes("bugfixresults")
      ) {
        return "report_bugfix_results"
      }
      return "report_bug"
    }
    if (
      normalized.includes("setactivebranch") ||
      normalized.includes("set_active_branch")
    )
      return "set_active_branch"
    if (normalized.includes("askquestion")) return "ask_question"
    if (normalized.includes("switchmode")) return "switch_mode"
    if (normalized.includes("createplan")) return "create_plan"
    if (
      normalized.includes("semsearch") ||
      normalized.includes("semanticsearch")
    ) {
      return "sem_search"
    }
    if (normalized.includes("truncated")) return "truncated"
    if (normalized.includes("reflect")) return "reflect"
    if (normalized.includes("executehook") || normalized === "hook") {
      return "execute_hook"
    }
    if (normalized.includes("task")) return "task"
    if (
      normalized.includes("grep") ||
      normalized.includes("ripgrep") ||
      normalized.includes("ripgraw")
    ) {
      return "grep"
    }
    if (normalized.includes("glob") || normalized.includes("filesearch")) {
      return "glob"
    }
    if (
      normalized === "read" ||
      normalized === "readfilev2" ||
      normalized.includes("readfile")
    ) {
      return "read"
    }
    if (
      normalized === "edit" ||
      normalized.includes("editfile") ||
      normalized.includes("writefile")
    ) {
      return "edit"
    }
    if (
      normalized === "ls" ||
      normalized === "lsv2" ||
      normalized.includes("listdir") ||
      normalized.includes("listdirectory")
    ) {
      return "ls"
    }
    if (normalized === "delete" || normalized.includes("deletefile")) {
      return "delete"
    }
    if (
      normalized.includes("shell") ||
      normalized.includes("terminal") ||
      normalized.includes("command")
    ) {
      return "shell"
    }
    if (normalized.includes("fetch")) return "fetch"
    if (
      normalized === "mcp" ||
      normalized === "mcptool" ||
      normalized === "clientsidetoolv2mcp" ||
      normalized === "clientsidetoolv2callmcptool"
    ) {
      return "mcp"
    }
    return "unknown"
  }

  isExecDispatchableTool(toolName: string): boolean {
    return this.execDispatchableFamilies.has(this.detectToolFamily(toolName))
  }

  getProtocolInlineOnlyToolCase(toolName: string): string | undefined {
    const family = this.detectToolFamily(toolName)
    if (!this.protocolInlineOnlyFamilies.has(family)) {
      return undefined
    }
    if (family === "setup_vm_environment")
      return "setup_vm_environment_tool_call"
    if (family === "get_mcp_tools") return "get_mcp_tools_tool_call"
    if (family === "read_todos") return "read_todos_tool_call"
    if (family === "apply_agent_diff") return "apply_agent_diff_tool_call"
    if (family === "sem_search") return "sem_search_tool_call"
    if (family === "web_fetch") return "web_fetch_tool_call"
    if (family === "web_search") return "web_search_tool_call"
    if (family === "exa_search") return "exa_search_tool_call"
    if (family === "exa_fetch") return "exa_fetch_tool_call"
    if (family === "generate_image") return "generate_image_tool_call"
    if (family === "task") return "task_tool_call"
    if (family === "ask_question") return "ask_question_tool_call"
    if (family === "switch_mode") return "switch_mode_tool_call"
    if (family === "reflect") return "reflect_tool_call"
    if (family === "start_grind_execution")
      return "start_grind_execution_tool_call"
    if (family === "start_grind_planning")
      return "start_grind_planning_tool_call"
    if (family === "report_bugfix_results")
      return "report_bugfix_results_tool_call"
    if (family === "fix_lints") return "truncated_tool_call"
    if (family === "truncated") return "truncated_tool_call"
    // New v2.6.13
    if (family === "await") return "await_tool_call"
    if (family === "ai_attribution") return "ai_attribution_tool_call"
    if (family === "mcp_auth") return "mcp_auth_tool_call"
    if (family === "pr_management") return "pr_management_tool_call"
    return undefined
  }

  isProtocolInlineOnlyTool(toolName: string): boolean {
    return Boolean(this.getProtocolInlineOnlyToolCase(toolName))
  }

  private extractStatusMessage(result: string): string {
    return result
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/^Tool execution aborted by client\.\s*/i, "")
      .trim()
  }

  private extractCreatePlanUri(value: unknown): string {
    const text = safeString(value).trim()
    if (!text) return ""

    const uriMatch =
      text.match(/(?:^|\n)\s*plan_uri\s*:\s*(.+)\s*$/im) ||
      text.match(/(?:^|\n)\s*planUri\s*:\s*(.+)\s*$/im)

    return uriMatch?.[1]?.trim() || ""
  }

  private buildMcpResultContentItems(result: string) {
    const text = safeString(result).trim()
    if (!text) return []

    const boundedText =
      text.length > 12_000 ? `${text.slice(0, 12_000)}\n...[truncated]` : text

    return [
      create(McpToolResultContentItemSchema, {
        content: {
          case: "text" as const,
          value: create(McpTextContentSchema, {
            text: boundedText,
          }),
        },
      }),
    ]
  }

  private detectToolResultStatus(
    result: string,
    extraData?: ToolCompletionExtraData
  ): ToolResultProjectionStatus {
    const explicit = extraData?.toolResultState?.status
    if (explicit) return explicit

    const normalized = result.trim().toLowerCase()
    if (normalized.startsWith("tool execution aborted by client"))
      return "aborted"
    if (
      normalized.startsWith("[shell timeout]") ||
      normalized.startsWith("[ls timeout]")
    ) {
      return "timeout"
    }
    if (normalized.startsWith("[shell rejected]")) return "rejected"
    if (normalized.startsWith("[permission denied]")) return "permission_denied"
    if (normalized.startsWith("[spawn error]")) return "spawn_error"
    if (normalized.includes("file not found")) return "file_not_found"
    if (normalized.includes("[invalid file]")) return "invalid_file"
    if (normalized.includes("file busy")) return "file_busy"
    if (
      normalized.includes("[read error]") ||
      normalized.includes("[write error]") ||
      normalized.includes("[delete error]") ||
      normalized.includes("[ls error]") ||
      normalized.includes("[grep error]") ||
      normalized.includes("error:")
    ) {
      return "error"
    }
    if (
      normalized.includes("rejected") ||
      normalized.includes("[read rejected]") ||
      normalized.includes("[write rejected]") ||
      normalized.includes("[delete rejected]") ||
      normalized.includes("[ls rejected]")
    ) {
      return "rejected"
    }
    if (
      extraData?.shellResult &&
      Number.isFinite(extraData.shellResult.exitCode) &&
      extraData.shellResult.exitCode !== 0
    ) {
      return "failure"
    }
    return "success"
  }

  private parseWebSearchReferences(result: string): Array<{
    title: string
    url: string
    chunk: string
  }> {
    const references: Array<{ title: string; url: string; chunk: string }> = []
    const seenUrls = new Set<string>()
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

    let match: RegExpExecArray | null
    while ((match = markdownLinkPattern.exec(result)) !== null) {
      const title = (match[1] || "").trim()
      const url = (match[2] || "").trim()
      if (!url || seenUrls.has(url)) continue
      seenUrls.add(url)
      const idx = match.index ?? 0
      const chunk = result
        .slice(Math.max(0, idx - 100), Math.min(result.length, idx + 220))
        .replace(/\s+/g, " ")
        .trim()
      references.push({
        title: title || url,
        url,
        chunk,
      })
      if (references.length >= 20) break
    }

    // Parse "Sources:\n[1] domain.com" style entries when URLs are omitted.
    const sourceLinePattern = /^\s*\[\d+\]\s+(.+)$/gm
    while ((match = sourceLinePattern.exec(result)) !== null) {
      const sourceLine = (match[1] || "").trim()
      if (!sourceLine) continue

      let title = sourceLine
      let url = ""

      const markdown = sourceLine.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/)
      if (markdown) {
        title = (markdown[1] || "").trim() || title
        url = (markdown[2] || "").trim()
      } else {
        const domainLike = sourceLine.match(
          /(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i
        )
        if (domainLike) {
          url = domainLike[0].trim().replace(/[),.;:!?]+$/, "")
          if (!/^https?:\/\//i.test(url)) {
            url = `https://${url}`
          }
          const cleanedTitle = sourceLine
            .replace(domainLike[0], "")
            .replace(/^[-:\s]+|[-:\s]+$/g, "")
            .trim()
          title = cleanedTitle || title
        }
      }

      if (!url || seenUrls.has(url)) continue
      seenUrls.add(url)
      references.push({
        title: title || url,
        url,
        chunk: sourceLine,
      })
      if (references.length >= 20) break
    }

    // Fallback for plain URLs when markdown links are missing.
    const plainUrlPattern = /https?:\/\/[^\s<>"')]+/g
    while ((match = plainUrlPattern.exec(result)) !== null) {
      const url = (match[0] || "").trim().replace(/[.,;:!?]+$/, "")
      if (!url || seenUrls.has(url)) continue

      let title = url
      try {
        const parsed = new URL(url)
        title = parsed.hostname.replace(/^www\./, "") || url
      } catch {
        // Keep original URL as title.
      }

      const idx = match.index ?? 0
      const chunk = result
        .slice(Math.max(0, idx - 100), Math.min(result.length, idx + 220))
        .replace(/\s+/g, " ")
        .trim()
      seenUrls.add(url)
      references.push({
        title,
        url,
        chunk,
      })
      if (references.length >= 20) break
    }

    return references
  }

  private buildWebSearchFallbackReferences(
    searchTerm: string,
    result: string
  ): Array<{
    title: string
    url: string
    chunk: string
  }> {
    const normalizedTerm = searchTerm.trim()
    if (!normalizedTerm) return []

    const snippet = result.replace(/\s+/g, " ").trim().slice(0, 320)
    const fallbackUrl = `https://www.google.com/search?q=${encodeURIComponent(normalizedTerm)}`

    return [
      {
        title: normalizedTerm,
        url: fallbackUrl,
        chunk: snippet || `Search query: ${normalizedTerm}`,
      },
    ]
  }

  private toRecordArray(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return []
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object"
    )
  }

  private normalizeListMcpResourceEntries(
    value: unknown,
    fallbackServer: string
  ): Array<{
    uri: string
    name?: string
    description?: string
    mimeType?: string
    server: string
    annotations: Record<string, string>
  }> {
    const normalized: Array<{
      uri: string
      name?: string
      description?: string
      mimeType?: string
      server: string
      annotations: Record<string, string>
    }> = []

    for (const entry of this.toRecordArray(value)) {
      const uri = safeString(entry.uri).trim()
      if (!uri) continue

      const server =
        safeString(entry.server || fallbackServer).trim() || fallbackServer

      const annotations: Record<string, string> = {}
      if (entry.annotations && typeof entry.annotations === "object") {
        for (const [rawKey, rawValue] of Object.entries(
          entry.annotations as Record<string, unknown>
        )) {
          const key = rawKey.trim()
          if (!key) continue
          annotations[key] = safeString(rawValue).trim()
        }
      }

      const name = safeString(entry.name).trim()
      const description = safeString(entry.description).trim()
      const mimeType = safeString(entry.mimeType || entry.mime_type).trim()

      normalized.push({
        uri,
        name: name || undefined,
        description: description || undefined,
        mimeType: mimeType || undefined,
        server,
        annotations,
      })
    }

    return normalized
  }

  private normalizeStringMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {}
    }

    const out: Record<string, string> = {}
    for (const [rawKey, rawValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      const key = rawKey.trim()
      if (!key) continue
      out[key] = safeString(rawValue).trim()
    }
    return out
  }

  private normalizeGlobFiles(args: Record<string, unknown>): {
    files: string[]
    totalFiles: number
    clientTruncated: boolean
    ripgrepTruncated: boolean
  } {
    const filesCandidate = Array.isArray(args.files)
      ? args.files
      : Array.isArray(args.matches)
        ? args.matches
        : []
    const files = filesCandidate
      .map((entry) => safeString(entry).trim())
      .filter((entry) => entry.length > 0)
    const totalRaw = Number(
      args.totalFiles ??
        args.total_files ??
        args.totalMatches ??
        args.total_matches ??
        files.length
    )
    const totalFiles = Number.isFinite(totalRaw)
      ? Math.max(files.length, Math.floor(totalRaw))
      : files.length
    return {
      files,
      totalFiles,
      clientTruncated: this.parseBooleanFlag(
        args.clientTruncated ?? args.client_truncated
      ),
      ripgrepTruncated: this.parseBooleanFlag(
        args.ripgrepTruncated ?? args.ripgrep_truncated
      ),
    }
  }

  private normalizeGlobCallArgs(args: Record<string, unknown>): {
    pattern: string
    targetDirectory: string
  } {
    return {
      pattern: safeString(
        args.pattern || args.query || args.globPattern || args.glob_pattern
      ),
      targetDirectory: safeString(
        args.path || args.targetDirectory || args.target_directory
      ),
    }
  }

  private escapeGrepLiteralPattern(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
  }

  private collapseGrepGlobPatterns(patterns: string[]): string | undefined {
    const normalized = patterns
      .map((entry) => safeString(entry).trim())
      .filter((entry) => entry.length > 0)
    if (normalized.length === 0) return undefined
    if (normalized.length === 1) return normalized[0]

    const positive = normalized.filter((entry) => !entry.startsWith("!"))
    const negative = normalized
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => entry.slice(1))
      .filter((entry) => entry.length > 0)

    if (positive.length > 1) {
      // agent.v1 GrepArgs currently supports a single glob field, so collapse
      // multi-include official payloads into a best-effort brace glob.
      return `{${positive.join(",")}}`
    }
    if (positive.length === 1) {
      return positive[0]
    }
    if (negative.length === 1) {
      return `!${negative[0]}`
    }
    return `!{${negative.join(",")}}`
  }

  private normalizeGrepCallArgs(args: Record<string, unknown>): {
    pattern: string
    path: string
    glob?: string
    outputMode?: string
    caseInsensitive?: boolean
    type?: string
    headLimit?: number
    offset?: number
  } {
    const hasOfficialShape =
      "SearchPath" in args ||
      "Query" in args ||
      "Includes" in args ||
      "MatchPerLine" in args ||
      "CaseInsensitive" in args ||
      "IsRegex" in args

    const explicitPattern = safeString(args.pattern).trim()
    const query = safeString(
      explicitPattern ||
        args.query ||
        args.Query ||
        args.regex ||
        args.searchTerm ||
        args.search_term
    ).trim()
    const isRegexRaw = args.isRegex ?? args.is_regex ?? args.IsRegex
    const isRegex =
      isRegexRaw === undefined ? undefined : this.parseBooleanFlag(isRegexRaw)
    const pattern =
      !explicitPattern &&
      query &&
      (isRegex === false || (hasOfficialShape && isRegex !== true))
        ? this.escapeGrepLiteralPattern(query)
        : query
    const path = safeString(
      args.path || args.SearchPath || args.searchPath || args.search_path
    ).trim()
    const directGlob = safeString(args.glob).trim()
    const includes = this.toStringArray(
      args.includes ?? args.Includes ?? args.include
    )
    const glob = directGlob || this.collapseGrepGlobPatterns(includes)
    const explicitOutputMode = safeString(
      args.output_mode || args.outputMode
    ).trim()
    const matchPerLineRaw =
      args.matchPerLine ?? args.match_per_line ?? args.MatchPerLine
    const matchPerLine =
      matchPerLineRaw === undefined
        ? undefined
        : this.parseBooleanFlag(matchPerLineRaw)
    const outputMode =
      explicitOutputMode ||
      (matchPerLine === false
        ? "files_with_matches"
        : matchPerLine === true || hasOfficialShape
          ? "content"
          : "")
    const caseInsensitiveRaw =
      args.caseInsensitive ??
      args.case_insensitive ??
      args.CaseInsensitive ??
      args["-i"]
    const caseSensitiveRaw =
      args.case_sensitive ?? args.caseSensitive ?? args.CaseSensitive
    const caseInsensitive =
      caseInsensitiveRaw === undefined
        ? caseSensitiveRaw === undefined
          ? undefined
          : !this.parseBooleanFlag(caseSensitiveRaw, true)
        : this.parseBooleanFlag(caseInsensitiveRaw)
    const type = safeString(args.type).trim()
    const headLimit =
      this.parseOptionalNonNegativeInt(
        args.head_limit ?? args.headLimit ?? args.HeadLimit
      ) ?? (hasOfficialShape ? 50 : undefined)
    const offset = this.parseOptionalNonNegativeInt(args.offset ?? args.Offset)

    return {
      pattern,
      path,
      ...(glob ? { glob } : {}),
      ...(outputMode ? { outputMode } : {}),
      ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
      ...(type ? { type } : {}),
      ...(headLimit !== undefined ? { headLimit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    }
  }

  private resolveLsPath(args: Record<string, unknown>): string {
    return safeString(
      args.path ||
        args.root_path ||
        args.rootPath ||
        args.project_path ||
        args.projectPath
    )
  }

  private normalizeGrepUnionResult(value: unknown):
    | {
        result: {
          case: "count" | "files" | "content"
          value: Record<string, unknown>
        }
      }
    | undefined {
    if (!value || typeof value !== "object") return undefined

    const record = value as Record<string, unknown>
    const oneOf = record.result
    if (oneOf && typeof oneOf === "object") {
      const result = oneOf as { case?: unknown; value?: unknown }
      if (
        (result.case === "count" ||
          result.case === "files" ||
          result.case === "content") &&
        result.value &&
        typeof result.value === "object"
      ) {
        return {
          result: {
            case: result.case,
            value: result.value as Record<string, unknown>,
          },
        }
      }
    }

    const directCount = record.count
    if (directCount && typeof directCount === "object") {
      return {
        result: {
          case: "count",
          value: directCount as Record<string, unknown>,
        },
      }
    }

    const directFiles = record.files
    if (directFiles && typeof directFiles === "object") {
      return {
        result: {
          case: "files",
          value: directFiles as Record<string, unknown>,
        },
      }
    }

    const directContent = record.content
    if (directContent && typeof directContent === "object") {
      return {
        result: {
          case: "content",
          value: directContent as Record<string, unknown>,
        },
      }
    }

    return undefined
  }

  private normalizeGrepWorkspaceResults(value: unknown): Record<
    string,
    {
      result: {
        case: "count" | "files" | "content"
        value: Record<string, unknown>
      }
    }
  > {
    if (!value) return {}

    const entries: Array<[string, unknown]> = []
    if (value instanceof Map) {
      for (const [key, item] of value.entries()) {
        entries.push([safeString(key), item])
      }
    } else if (typeof value === "object") {
      entries.push(
        ...Object.entries(value as Record<string, unknown>).map(
          ([key, item]) => [safeString(key), item] as [string, unknown]
        )
      )
    }

    const normalized: Record<
      string,
      {
        result: {
          case: "count" | "files" | "content"
          value: Record<string, unknown>
        }
      }
    > = {}

    for (const [key, item] of entries) {
      const normalizedKey = key.trim()
      if (!normalizedKey) continue
      const normalizedItem = this.normalizeGrepUnionResult(item)
      if (!normalizedItem) continue
      normalized[normalizedKey] = normalizedItem
    }

    return normalized
  }

  private normalizeExaSearchReferences(
    args: Record<string, unknown>,
    result: string
  ): Array<{
    title: string
    url: string
    text: string
    publishedDate: string
  }> {
    const structured = this.toRecordArray(args.references).map((entry) => ({
      title: safeString(entry.title),
      url: safeString(entry.url),
      text: safeString(entry.text || entry.chunk),
      publishedDate: safeString(entry.publishedDate || entry.published_date),
    }))
    const filteredStructured = structured.filter(
      (entry) => entry.url.length > 0
    )
    if (filteredStructured.length > 0) {
      return filteredStructured.slice(0, 20)
    }

    return this.parseWebSearchReferences(result)
      .map((reference) => ({
        title: reference.title,
        url: reference.url,
        text: reference.chunk,
        publishedDate: "",
      }))
      .slice(0, 20)
  }

  private parseExaFetchContentsFromText(result: string): Array<{
    title: string
    url: string
    text: string
    publishedDate: string
  }> {
    const segments = result
      .split(/\n\s*---\s*\n/g)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
    const contents: Array<{
      title: string
      url: string
      text: string
      publishedDate: string
    }> = []

    for (const segment of segments) {
      const urlMatch = segment.match(/^URL:\s*(.+)$/m)
      if (!urlMatch) continue
      const url = safeString(urlMatch[1]).trim()
      if (!url) continue

      const titleMatch = segment.match(/^Title:\s*(.+)$/m)
      const title = safeString(titleMatch?.[1] || url).trim() || url
      let text = segment
      if (titleMatch) {
        const indexAfterTitle =
          segment.indexOf(titleMatch[0]) + titleMatch[0].length
        text = segment.slice(indexAfterTitle).trim()
      } else {
        text = segment.replace(/^URL:\s*.+$/m, "").trim()
      }
      contents.push({
        title,
        url,
        text: text.slice(0, 8_000),
        publishedDate: "",
      })
      if (contents.length >= 10) break
    }

    return contents
  }

  private normalizeExaFetchContents(
    args: Record<string, unknown>,
    result: string
  ): Array<{
    title: string
    url: string
    text: string
    publishedDate: string
  }> {
    const structured = this.toRecordArray(args.contents).map((entry) => ({
      title: safeString(entry.title),
      url: safeString(entry.url),
      text: safeString(entry.text),
      publishedDate: safeString(entry.publishedDate || entry.published_date),
    }))
    const filteredStructured = structured.filter(
      (entry) => entry.url.length > 0
    )
    if (filteredStructured.length > 0) {
      return filteredStructured.slice(0, 10)
    }
    return this.parseExaFetchContentsFromText(result)
  }

  private normalizeBugfixResultItems(value: unknown) {
    return normalizeBugfixResultItemsFromContract(value).items.map((entry) => ({
      bugId: entry.bugId,
      bugTitle: entry.bugTitle,
      verdict: entry.verdict,
      explanation: entry.explanation,
    }))
  }

  private resolveWebFetchUrl(args: Record<string, unknown>): string {
    return safeString(
      args.url || args.Url || args.document_id || args.documentId
    )
  }

  private parseBooleanFlag(value: unknown, defaultValue = false): boolean {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) && value !== 0
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (!normalized) return defaultValue
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false
    }
    return defaultValue
  }

  private normalizeAskQuestionOptionId(
    value: unknown,
    fallback: string
  ): string {
    const normalized = safeString(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
    return normalized || fallback
  }

  private normalizeAskQuestionOptions(
    value: unknown,
    questionIndex: number
  ): Array<{ id: string; label: string }> {
    if (!Array.isArray(value)) return []

    const normalized: Array<{ id: string; label: string }> = []
    const seenIds = new Set<string>()

    for (const [optionIndex, entry] of value.entries()) {
      let id = ""
      let label = ""

      if (typeof entry === "string") {
        label = entry.trim()
      } else if (entry && typeof entry === "object") {
        const option = entry as Record<string, unknown>
        id = safeString(option.id || option.optionId || option.option_id).trim()
        label = safeString(
          option.label ||
            option.text ||
            option.title ||
            option.name ||
            option.value
        ).trim()
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
      if (seenIds.has(id)) continue

      seenIds.add(id)
      normalized.push({ id, label })
    }

    return normalized
  }

  private normalizeAskQuestionArgs(
    args: Record<string, unknown>,
    callId: string
  ): {
    title: string
    questions: Array<{
      id: string
      prompt: string
      options: Array<{ id: string; label: string }>
      allowMultiple: boolean
    }>
    runAsync: boolean
    asyncOriginalToolCallId: string
  } {
    const explicitTitle = safeString(args.question || args.title).trim()
    const runAsync = this.parseBooleanFlag(args.runAsync ?? args.run_async)
    const explicitAsyncOriginalToolCallId = safeString(
      args.asyncOriginalToolCallId || args.async_original_tool_call_id
    ).trim()

    const questions = this.toRecordArray(args.questions)
      .map((question, index) => {
        const prompt =
          safeString(
            question.prompt ||
              question.question ||
              question.title ||
              question.label ||
              explicitTitle
          ).trim() || `Question ${index + 1}`
        const id =
          safeString(
            question.id || question.questionId || question.question_id
          ).trim() || `q${index + 1}`
        const options = this.normalizeAskQuestionOptions(
          Array.isArray(question.options)
            ? question.options
            : Array.isArray(question.choices)
              ? question.choices
              : [],
          index + 1
        )
        const allowMultiple = this.parseBooleanFlag(
          question.allowMultiple ?? question.allow_multiple
        )
        return {
          id,
          prompt,
          options,
          allowMultiple,
        }
      })
      .filter((question) => question.prompt.trim().length > 0)

    if (questions.length === 0) {
      questions.push({
        id: "q1",
        prompt: explicitTitle || "Follow-up",
        options: this.normalizeAskQuestionOptions(
          Array.isArray(args.options)
            ? args.options
            : Array.isArray(args.choices)
              ? args.choices
              : [],
          1
        ),
        allowMultiple: this.parseBooleanFlag(
          args.allowMultiple ?? args.allow_multiple
        ),
      })
    }

    return {
      title: explicitTitle || questions[0]?.prompt || "Follow-up",
      questions,
      runAsync,
      asyncOriginalToolCallId: runAsync
        ? explicitAsyncOriginalToolCallId || callId
        : explicitAsyncOriginalToolCallId,
    }
  }

  private parseOptionalNonNegativeInt(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined
    if (typeof value === "string" && value.trim() === "") return undefined
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return undefined
    const normalized = Math.floor(numeric)
    if (normalized < 0) return undefined
    return normalized
  }

  private normalizeOptionalBigInt(value: unknown): bigint | undefined {
    if (value === null || value === undefined) return undefined
    if (typeof value === "bigint") return value >= 0n ? value : undefined
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) return undefined
      return BigInt(Math.floor(value))
    }
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) return undefined
      try {
        const parsed = BigInt(trimmed)
        return parsed >= 0n ? parsed : undefined
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private normalizeOutputLocation(value: unknown) {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    const filePath = safeString(record.filePath || record.file_path).trim()
    const sizeBytes = this.normalizeOptionalBigInt(
      record.sizeBytes ?? record.size_bytes
    )
    const lineCount = this.normalizeOptionalBigInt(
      record.lineCount ?? record.line_count
    )
    if (!filePath && sizeBytes === undefined && lineCount === undefined) {
      return undefined
    }
    return create(OutputLocationSchema, {
      filePath,
      sizeBytes: sizeBytes ?? 0n,
      lineCount: lineCount ?? 0n,
    })
  }

  private normalizeShellAbortReason(
    value: unknown
  ): ShellAbortReason | undefined {
    const parsed = this.parseOptionalNonNegativeInt(value)
    return parsed === undefined ? undefined : (parsed as ShellAbortReason)
  }

  private normalizeShellBackgroundReason(
    value: unknown
  ): ShellBackgroundReason | undefined {
    const parsed = this.parseOptionalNonNegativeInt(value)
    return parsed === undefined ? undefined : (parsed as ShellBackgroundReason)
  }

  private normalizeTimeoutBehavior(
    value: unknown
  ): TimeoutBehavior | undefined {
    const parsed = this.parseOptionalNonNegativeInt(value)
    return parsed === undefined ? undefined : (parsed as TimeoutBehavior)
  }

  private normalizeShellClassifierResult(value: unknown) {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    const commands = Array.isArray(record.commands)
      ? record.commands
          .map((entry) => {
            if (!entry || typeof entry !== "object") return undefined
            const command = entry as Record<string, unknown>
            return {
              name: safeString(command.name),
              arguments: Array.isArray(command.arguments)
                ? command.arguments.map((arg) => safeString(arg))
                : [],
            }
          })
          .filter((entry) => !!entry)
      : []
    const suggestedSandboxMode = this.parseOptionalNonNegativeInt(
      record.suggestedSandboxMode ?? record.suggested_sandbox_mode
    )
    const classificationFailed = this.parseBooleanFlag(
      record.classificationFailed ?? record.classification_failed
    )
    if (
      commands.length === 0 &&
      suggestedSandboxMode === undefined &&
      !classificationFailed
    ) {
      return undefined
    }
    return create(CommandClassifierResultSchema, {
      commands,
      suggestedSandboxMode: suggestedSandboxMode ?? 0,
      classificationFailed,
    })
  }

  private buildShellArgsMessage(
    callId: string,
    args: Record<string, unknown>,
    shellResult?: ToolCompletionExtraData["shellResult"]
  ) {
    const command = safeString(args.command)
    const workingDirectory = safeString(
      args.cwd || args.working_directory || args.workingDirectory
    )
    const parsed = buildShellParsingMetadata(command)
    const requestedSandboxPolicyArg =
      args.requestedSandboxPolicy &&
      typeof args.requestedSandboxPolicy === "object"
        ? (args.requestedSandboxPolicy as Record<string, unknown>)
        : args.requested_sandbox_policy &&
            typeof args.requested_sandbox_policy === "object"
          ? (args.requested_sandbox_policy as Record<string, unknown>)
          : undefined
    const requestedSandboxType = this.parseOptionalNonNegativeInt(
      shellResult?.requestedSandboxPolicy?.type ??
        requestedSandboxPolicyArg?.type
    )
    const timeoutBehavior = this.normalizeTimeoutBehavior(
      shellResult?.timeoutBehavior ??
        args.timeoutBehavior ??
        args.timeout_behavior
    )
    const hardTimeout = this.parseOptionalNonNegativeInt(
      shellResult?.hardTimeout ?? args.hardTimeout ?? args.hard_timeout
    )
    const fileOutputThresholdBytes = this.normalizeOptionalBigInt(
      shellResult?.fileOutputThresholdBytes ??
        args.fileOutputThresholdBytes ??
        args.file_output_threshold_bytes
    )
    return create(ShellArgsSchema, {
      command,
      workingDirectory,
      timeout: normalizeShellTimeoutMs(args.timeout),
      toolCallId: safeString(args.toolCallId || args.tool_call_id || callId),
      simpleCommands: parsed.simpleCommands,
      hasInputRedirect: parsed.hasInputRedirect,
      hasOutputRedirect: parsed.hasOutputRedirect,
      parsingResult: parsed.parsingResult,
      requestedSandboxPolicy:
        requestedSandboxType !== undefined
          ? create(SandboxPolicySchema, {
              type: requestedSandboxType as SandboxPolicy_Type,
            })
          : undefined,
      fileOutputThresholdBytes,
      isBackground: this.parseBooleanFlag(
        shellResult?.isBackground ?? args.isBackground ?? args.is_background
      ),
      skipApproval: true,
      timeoutBehavior: timeoutBehavior ?? TimeoutBehavior.UNSPECIFIED,
      hardTimeout,
      description:
        safeString(shellResult?.description || args.description).trim() ||
        undefined,
      classifierResult: this.normalizeShellClassifierResult(
        shellResult?.classifierResult ??
          args.classifierResult ??
          args.classifier_result
      ),
      closeStdin: this.parseBooleanFlag(
        shellResult?.closeStdin ?? args.closeStdin ?? args.close_stdin
      ),
    })
  }

  private normalizeReadLintsDiagnosticPosition(
    value: unknown
  ): { line: number; column: number } | undefined {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    return {
      line: safeUint32(record.line, 0),
      column: safeUint32(record.column, 0),
    }
  }

  private normalizeReadLintsDiagnosticRange(value: unknown):
    | {
        start?: { line: number; column: number }
        end?: { line: number; column: number }
      }
    | undefined {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    const start = this.normalizeReadLintsDiagnosticPosition(record.start)
    const end = this.normalizeReadLintsDiagnosticPosition(record.end)
    if (!start && !end) return undefined
    return {
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    }
  }

  private normalizeReadLintsDiagnosticItems(value: unknown): Array<{
    severity: number
    range?: {
      start?: { line: number; column: number }
      end?: { line: number; column: number }
    }
    message: string
    source: string
    code: string
    isStale: boolean
  }> {
    if (!Array.isArray(value)) return []

    const items: Array<{
      severity: number
      range?: {
        start?: { line: number; column: number }
        end?: { line: number; column: number }
      }
      message: string
      source: string
      code: string
      isStale: boolean
    }> = []

    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const record = entry as Record<string, unknown>
      const range = this.normalizeReadLintsDiagnosticRange(record.range)
      items.push({
        severity: this.parseOptionalNonNegativeInt(record.severity) ?? 0,
        ...(range ? { range } : {}),
        message: safeString(record.message),
        source: safeString(record.source),
        code: safeString(record.code),
        isStale: this.parseBooleanFlag(record.isStale ?? record.is_stale),
      })
    }

    return items
  }

  private resolveReadPath(args: Record<string, unknown>): string {
    const arrayCandidate = (
      Array.isArray(args.file_paths)
        ? args.file_paths
        : Array.isArray(args.paths)
          ? args.paths
          : Array.isArray(args.files)
            ? args.files
            : []
    )
      .map((entry) => safeString(entry).trim())
      .find((entry) => entry.length > 0)

    return safeString(
      args.path || args.file_path || args.filePath || arrayCandidate
    ).trim()
  }

  private normalizeReadToolArgs(args: Record<string, unknown>): {
    path: string
    offset?: number
    limit?: number
    includeLineNumbers?: boolean
  } {
    const path = this.resolveReadPath(args)

    let offset = this.parseOptionalNonNegativeInt(args.offset)
    let limit = this.parseOptionalNonNegativeInt(args.limit)

    const startLine = this.parseOptionalNonNegativeInt(
      args.start_line ?? args.startLine
    )
    const endLine = this.parseOptionalNonNegativeInt(
      args.end_line ?? args.endLine
    )

    // Cursor read_file_v2 uses 1-indexed line range; proto ReadToolArgs uses offset/limit.
    if (offset === undefined && startLine !== undefined) {
      offset = Math.max(startLine - 1, 0)
    }
    if (
      limit === undefined &&
      startLine !== undefined &&
      endLine !== undefined &&
      endLine >= startLine
    ) {
      limit = endLine - startLine + 1
    }

    const includeLineNumbersRaw =
      args.includeLineNumbers ?? args.include_line_numbers
    const includeLineNumbers =
      includeLineNumbersRaw === undefined
        ? undefined
        : this.parseBooleanFlag(includeLineNumbersRaw)

    return {
      path,
      offset,
      limit,
      includeLineNumbers,
    }
  }

  private normalizeTodoStatusEnum(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      const rounded = Math.floor(value)
      if (rounded >= 0 && rounded <= 4) return rounded
    }

    const normalized = safeString(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
    if (!normalized) return 1

    if (
      normalized === "in_progress" ||
      normalized === "inprogress" ||
      normalized === "todo_status_in_progress"
    ) {
      return 2
    }
    if (
      normalized === "completed" ||
      normalized === "done" ||
      normalized === "todo_status_completed"
    ) {
      return 3
    }
    if (
      normalized === "cancelled" ||
      normalized === "canceled" ||
      normalized === "todo_status_cancelled" ||
      normalized === "todo_status_canceled"
    ) {
      return 4
    }
    return 1
  }

  private buildCreatePlanArgs(args: Record<string, unknown>) {
    const title = safeString(args.title || args.name).trim()
    const overview = safeString(args.overview || args.description).trim()

    // LLM tool definition sends `steps: string[]`, map them to both plan text and todos
    const rawSteps = Array.isArray(args.steps) ? args.steps : []
    const stepsStrings = rawSteps
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)

    // Build plan text from explicit narrative fields only.
    // Do not mirror steps into `plan`, because Cursor already renders todos
    // separately and the UI would show duplicated content.
    let plan = safeString(args.plan).trim()
    if (!plan) {
      plan = overview || title || "Plan"
    }

    // Build todos: prefer explicit todos, fallback to converting steps strings
    let todos = this.parseTodoItemsForProto(args.todos)
    if (todos.length === 0 && stepsStrings.length > 0) {
      const nowTs = Date.now()
      todos = stepsStrings.map((content, index) =>
        create(TodoItemSchema, {
          id: `step_${nowTs}_${index}`,
          content,
          status: 1, // TODO_STATUS_PENDING
          createdAt: BigInt(nowTs),
          updatedAt: BigInt(nowTs),
          dependencies: [],
        })
      )
    }

    const phases = this.parsePhasesForProto(args.phases)

    return create(CreatePlanArgsSchema, {
      plan,
      todos,
      overview,
      name: title || plan,
      isProject: this.parseBooleanFlag(args.isProject ?? args.is_project),
      phases,
    })
  }

  /**
   * Parse raw todo items from LLM args into proto TodoItem objects.
   */
  private parseTodoItemsForProto(value: unknown) {
    if (!Array.isArray(value)) return []
    const nowTs = Date.now()
    return value
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") return undefined
        const item = entry as Record<string, unknown>
        const id =
          safeString(item.id || item.todo_id || item.todoId).trim() ||
          `todo_${nowTs}_${index}`
        const content = safeString(
          item.content || item.text || item.title
        ).trim()
        const createdAtRaw = Number(item.createdAt ?? item.created_at)
        const updatedAtRaw = Number(item.updatedAt ?? item.updated_at)
        return create(TodoItemSchema, {
          id,
          content,
          status: this.normalizeTodoStatusEnum(item.status),
          createdAt:
            Number.isFinite(createdAtRaw) && createdAtRaw > 0
              ? BigInt(Math.floor(createdAtRaw))
              : BigInt(nowTs),
          updatedAt:
            Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
              ? BigInt(Math.floor(updatedAtRaw))
              : BigInt(nowTs),
          dependencies: (() => {
            const raw = item.dependencies || item.depends_on || item.dependsOn
            if (!Array.isArray(raw)) return []
            return raw.filter((v): v is string => typeof v === "string")
          })(),
        })
      })
      .filter((item): item is Exclude<typeof item, undefined> => !!item)
  }

  /**
   * Parse raw phases from LLM args into proto Phase objects.
   */
  private parsePhasesForProto(value: unknown) {
    if (!Array.isArray(value)) return []
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") return undefined
        const phase = entry as Record<string, unknown>
        return create(PhaseSchema, {
          name: safeString(phase.name || phase.title).trim(),
          todos: this.parseTodoItemsForProto(phase.todos),
        })
      })
      .filter((item): item is Exclude<typeof item, undefined> => !!item)
  }

  private buildTaskArgs(args: Record<string, unknown>) {
    const prompt = safeString(
      args.prompt ||
        args.description ||
        args.task ||
        args.message ||
        args.key ||
        args.value
    )
    const description = safeString(
      args.description ||
        args.prompt ||
        args.task ||
        args.message ||
        args.value ||
        args.key
    )
    const model = safeString(args.model).trim()
    const resume = safeString(args.resume).trim()
    const agentId = safeString(args.agentId || args.agent_id).trim()
    const attachments = this.toStringArray(args.attachments)
    return create(TaskArgsSchema, {
      description,
      prompt,
      model: model || undefined,
      resume: resume || undefined,
      agentId: agentId || undefined,
      attachments,
    })
  }

  private buildLsDirectoryTreeNode(
    value: unknown,
    fallbackAbsPath = ""
  ): ReturnType<typeof create<typeof LsDirectoryTreeNodeSchema>> {
    if (!value || typeof value !== "object") {
      return create(LsDirectoryTreeNodeSchema, {
        absPath: fallbackAbsPath,
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: false,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      })
    }

    const node = value as Record<string, unknown>
    const childrenDirs = Array.isArray(node.childrenDirs)
      ? node.childrenDirs.map((entry) =>
          this.buildLsDirectoryTreeNode(entry, fallbackAbsPath)
        )
      : []
    const childrenFiles = Array.isArray(node.childrenFiles)
      ? node.childrenFiles
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => {
            const file = entry as Record<string, unknown>
            return {
              name: safeString(file.name),
            }
          })
      : []
    const rawExtCounts =
      node.fullSubtreeExtensionCounts &&
      typeof node.fullSubtreeExtensionCounts === "object"
        ? (node.fullSubtreeExtensionCounts as Record<string, unknown>)
        : {}
    const fullSubtreeExtensionCounts = Object.fromEntries(
      Object.entries(rawExtCounts).map(([key, raw]) => {
        const numeric = Number(raw)
        return [key, Number.isFinite(numeric) ? Math.floor(numeric) : 0]
      })
    )

    const numericNumFiles = Number(node.numFiles)
    const numFiles = Number.isFinite(numericNumFiles)
      ? Math.max(0, Math.floor(numericNumFiles))
      : childrenFiles.length

    return create(LsDirectoryTreeNodeSchema, {
      absPath: safeString(node.absPath, fallbackAbsPath),
      childrenDirs,
      childrenFiles: childrenFiles as LsDirectoryTreeNode_File[],
      childrenWereProcessed: this.parseBooleanFlag(
        node.childrenWereProcessed,
        childrenDirs.length > 0 || childrenFiles.length > 0
      ),
      fullSubtreeExtensionCounts,
      numFiles,
    })
  }

  /**
   * Resolve MCP call identity fields with protocol-compatible normalization.
   * Accepts payload variants that provide either `name` or `tool_name` and
   * derives the missing counterpart when possible.
   */
  private resolveMcpCallFields(args: Record<string, unknown>): {
    name: string
    toolName: string
    providerIdentifier: string
    rawArgs: Record<string, unknown>
  } {
    try {
      return resolveMcpCallFieldsFromContract(args)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid MCP call fields: ${reason}`)
    }
  }

  /**
   * 构建 ExecServerMessage
   */
  private buildExecServerMessage(
    toolName: string,
    args: ToolArgs,
    execIdNumber: number,
    toolCallId: string,
    execId: string
  ) {
    // 根据 toolName 选择正确的 oneof case 和 args 构建
    const messageOneOf = this.buildExecMessageOneOf(toolName, args, toolCallId)

    return create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage" as const,
        value: create(ExecServerMessageSchema, {
          id: execIdNumber,
          execId,
          spanContext: this.buildSpanContext(),
          message: messageOneOf,
        }),
      },
    })
  }

  /**
   * 根据 toolName 构建 ExecServerMessage 的 oneof message
   */
  private buildExecMessageOneOf(
    toolName: string,
    args: ToolArgs,
    toolCallId: string
  ): ExecServerMessage["message"] {
    const family = this.detectToolFamily(toolName)

    switch (family) {
      case "read_mcp_resource": {
        const a = args as ReadMcpResourceArgs
        const downloadPath = safeString(
          a.downloadPath || a.download_path
        ).trim()
        return {
          case: "readMcpResourceExecArgs" as const,
          value: create(ReadMcpResourceExecArgsSchema, {
            server: safeString(a.serverName || a.server || a.server_name),
            uri: safeString(a.uri),
            downloadPath: downloadPath || undefined,
          }),
        }
      }
      case "list_mcp_resources": {
        const a = args as ListMcpResourcesArgs
        return {
          case: "listMcpResourcesExecArgs" as const,
          value: create(ListMcpResourcesExecArgsSchema, {
            server: safeString(a.serverName || a.server || a.server_name),
          }),
        }
      }
      case "read": {
        const normalizedReadArgs = this.normalizeReadToolArgs(
          args as Record<string, unknown>
        )
        return {
          case: "readArgs" as const,
          value: create(ReadArgsSchema, {
            path: normalizedReadArgs.path,
            toolCallId,
            offset: normalizedReadArgs.offset,
            limit: normalizedReadArgs.limit,
          }),
        }
      }
      case "edit": {
        const a = args as EditFileArgs
        return {
          case: "writeArgs" as const,
          value: create(WriteArgsSchema, {
            path: safeString(a.path),
            fileText: safeString(a.new_text || a.replace),
            toolCallId,
          }),
        }
      }
      case "delete": {
        const a = args as DeleteFileArgs
        return {
          case: "deleteArgs" as const,
          value: create(DeleteArgsSchema, {
            path: safeString(a.path),
            toolCallId,
          }),
        }
      }
      case "shell": {
        return {
          case: "shellStreamArgs" as const,
          value: this.buildShellArgsMessage(
            toolCallId,
            args as Record<string, unknown>
          ),
        }
      }
      case "ls": {
        const path = this.resolveLsPath(args as Record<string, unknown>)
        return {
          case: "lsArgs" as const,
          value: create(LsArgsSchema, {
            path,
            toolCallId,
          }),
        }
      }
      case "grep": {
        const a = this.normalizeGrepCallArgs(args as Record<string, unknown>)
        return {
          case: "grepArgs" as const,
          value: create(GrepArgsSchema, {
            pattern: a.pattern,
            path: a.path || undefined,
            glob: a.glob,
            outputMode: a.outputMode,
            caseInsensitive: a.caseInsensitive,
            type: a.type,
            headLimit: a.headLimit,
            offset: a.offset,
            toolCallId,
          }),
        }
      }
      case "read_lints": {
        const a = args as DiagnosticsArgs
        const path =
          this.toStringArray(a.paths).find(
            (candidate) => candidate.length > 0
          ) || safeString(a.path)
        return {
          case: "diagnosticsArgs" as const,
          value: create(DiagnosticsArgsSchema, {
            path,
            toolCallId,
          }),
        }
      }
      case "mcp": {
        const a = args as McpArgs
        const { name, toolName, providerIdentifier, rawArgs } =
          this.resolveMcpCallFields(a as unknown as Record<string, unknown>)
        return {
          case: "mcpArgs" as const,
          value: create(McpArgsSchema, {
            name,
            toolName,
            providerIdentifier,
            args: this.toProtoValueMap(rawArgs),
            toolCallId,
          }),
        }
      }
      case "background_shell_spawn": {
        const a = args as BackgroundShellSpawnArgs & Record<string, unknown>
        const command = safeString(a.command)
        const parsed = buildShellParsingMetadata(command)
        return {
          case: "backgroundShellSpawnArgs" as const,
          value: create(BackgroundShellSpawnArgsSchema, {
            command,
            workingDirectory: safeString(
              a.cwd || a.working_directory || a.workingDirectory
            ),
            toolCallId,
            parsingResult: parsed.parsingResult,
            enableWriteShellStdinTool: this.parseBooleanFlag(
              a.enableWriteShellStdinTool ?? a.enable_write_shell_stdin_tool,
              true
            ),
          }),
        }
      }
      case "fetch": {
        const a = args as FetchArgs
        return {
          case: "fetchArgs" as const,
          value: create(FetchArgsSchema, {
            url: safeString(a.url),
            toolCallId,
          }),
        }
      }
      case "record_screen": {
        const a = args as RecordScreenArgs
        const mode = this.parseRecordScreenMode(a.mode)
        const saveAsFilename = safeString(
          a.saveAsFilename || a.save_as_filename
        ).trim()
        return {
          case: "recordScreenArgs" as const,
          value: create(RecordScreenArgsSchema, {
            mode,
            toolCallId,
            saveAsFilename: saveAsFilename || undefined,
          }),
        }
      }
      case "computer_use": {
        const a = args as ComputerUseArgs
        const actions = Array.isArray(a.actions)
          ? (a.actions as Record<string, unknown>[])
          : []
        return {
          case: "computerUseArgs" as const,
          value: create(ComputerUseArgsSchema, {
            toolCallId,
            actions: actions,
          }),
        }
      }
      case "write_shell_stdin": {
        const a = args as WriteShellStdinArgs
        return {
          case: "writeShellStdinArgs" as const,
          value: create(WriteShellStdinArgsSchema, {
            shellId: safeUint32(a.shellId ?? a.shell_id, 0),
            chars: safeString(a.data ?? a.chars),
          }),
        }
      }
      case "execute_hook":
        return {
          case: "executeHookArgs" as const,
          value: create(ExecuteHookArgsSchema, {}),
        }
      default: {
        const message = `Unknown tool "${toolName}" has no ExecServerMessage mapping`
        this.logger.error(message)
        throw new Error(message)
      }
    }
  }

  // ─── ToolCall V2 构建 ──────────────────────────────────────

  /**
   * 构建 ToolCall V2 消息
   */
  private buildToolCallV2(
    toolName: string,
    callId: string,
    args: Record<string, unknown>,
    toolFamilyHint?: ToolFamily
  ) {
    const toolOneOf = this.buildToolCallOneOf(
      toolName,
      args,
      callId,
      toolFamilyHint
    )
    return create(ToolCallSchema, {
      tool: toolOneOf,
    })
  }

  private resolveToolFamily(
    toolName: string,
    toolFamilyHint?: ToolFamily
  ): ToolFamily {
    return toolFamilyHint || this.detectToolFamily(toolName)
  }

  /**
   * 构建空的 ToolCall V2（用于初始 partialToolCall 通知）
   */
  private buildEmptyToolCallV2(toolName: string, toolFamilyHint?: ToolFamily) {
    const family = this.resolveToolFamily(toolName, toolFamilyHint)
    const familyToCase: Record<ToolFamily, string> = {
      get_mcp_tools: "getMcpToolsToolCall",
      read_mcp_resource: "readMcpResourceToolCall",
      list_mcp_resources: "listMcpResourcesToolCall",
      read_lints: "readLintsToolCall",
      fix_lints: "truncatedToolCall",
      read_todos: "readTodosToolCall",
      update_todos: "updateTodosToolCall",
      apply_agent_diff: "applyAgentDiffToolCall",
      write_shell_stdin: "writeShellStdinToolCall",
      background_shell_spawn: "shellToolCall",
      setup_vm_environment: "setupVmEnvironmentToolCall",
      start_grind_execution: "startGrindExecutionToolCall",
      start_grind_planning: "startGrindPlanningToolCall",
      report_bugfix_results: "reportBugfixResultsToolCall",
      generate_image: "generateImageToolCall",
      record_screen: "recordScreenToolCall",
      computer_use: "computerUseToolCall",
      web_search: "webSearchToolCall",
      web_fetch: "webFetchToolCall",
      exa_search: "exaSearchToolCall",
      exa_fetch: "exaFetchToolCall",
      ask_question: "askQuestionToolCall",
      switch_mode: "switchModeToolCall",
      create_plan: "createPlanToolCall",
      sem_search: "semSearchToolCall",
      truncated: "truncatedToolCall",
      reflect: "reflectToolCall",
      read: "readToolCall",
      edit: "editToolCall",
      ls: "lsToolCall",
      delete: "deleteToolCall",
      grep: "grepToolCall",
      glob: "globToolCall",
      fetch: "fetchToolCall",
      mcp: "mcpToolCall",
      task: "taskToolCall",
      shell: "shellToolCall",
      execute_hook: "truncatedToolCall",
      // New v2.6.13
      await: "awaitToolCall",
      ai_attribution: "aiAttributionToolCall",
      mcp_auth: "mcpAuthToolCall",
      pr_management: "prManagementToolCall",
      blame_by_file_path: "blameByFilePathToolCall",
      report_bug: "reportBugToolCall",
      set_active_branch: "setActiveBranchToolCall",
      unknown: "truncatedToolCall",
    }
    const matchedCase = familyToCase[family] || "truncatedToolCall"

    return create(ToolCallSchema, {
      tool: { case: matchedCase, value: {} } as ToolCallOneOf,
    })
  }

  private buildReflectArgs(args: Record<string, unknown>, callId: string) {
    const criticalSynthesisFromArgs =
      args.criticalSynthesis || args.critical_synthesis || args.explanation
    return create(ReflectArgsSchema, {
      unexpectedActionOutcomes: safeString(
        args.unexpectedActionOutcomes || args.unexpected_action_outcomes
      ),
      relevantInstructions: safeString(
        args.relevantInstructions || args.relevant_instructions
      ),
      scenarioAnalysis: safeString(
        args.scenarioAnalysis || args.scenario_analysis
      ),
      criticalSynthesis: safeString(criticalSynthesisFromArgs),
      nextSteps: safeString(args.nextSteps || args.next_steps),
      toolCallId: safeString(args.toolCallId || args.tool_call_id || callId),
    })
  }

  /**
   * 构建 ToolCall 的 oneof tool 部分
   * ToolCall 类型结构：{ args: XxxArgs, result: XxxResult }
   * 覆盖所有常用的 38 种工具类型
   */
  private buildToolCallOneOf(
    toolName: string,
    args: Record<string, unknown>,
    callId: string = "",
    toolFamilyHint?: ToolFamily
  ): ToolCallOneOf {
    const family = this.resolveToolFamily(toolName, toolFamilyHint)

    switch (family) {
      case "shell":
      case "background_shell_spawn":
        return {
          case: "shellToolCall" as const,
          value: create(ShellToolCallSchema, {
            args: this.buildShellArgsMessage(callId, args),
          }),
        }
      case "delete":
        return {
          case: "deleteToolCall" as const,
          value: create(DeleteToolCallSchema, {
            args: create(DeleteArgsSchema, {
              path: safeString(args.path),
            }),
          }),
        }
      case "glob": {
        const globArgs = this.normalizeGlobCallArgs(args)
        return {
          case: "globToolCall" as const,
          value: create(GlobToolCallSchema, {
            args: create(GlobToolArgsSchema, {
              globPattern: globArgs.pattern,
              targetDirectory: globArgs.targetDirectory || undefined,
            }),
          }),
        }
      }
      case "grep": {
        const normalizedGrepArgs = this.normalizeGrepCallArgs(args)
        return {
          case: "grepToolCall" as const,
          value: create(GrepToolCallSchema, {
            args: create(GrepArgsSchema, {
              pattern: normalizedGrepArgs.pattern,
              path: normalizedGrepArgs.path || undefined,
              glob: normalizedGrepArgs.glob,
              outputMode: normalizedGrepArgs.outputMode,
              caseInsensitive: normalizedGrepArgs.caseInsensitive,
              type: normalizedGrepArgs.type,
              headLimit: normalizedGrepArgs.headLimit,
              offset: normalizedGrepArgs.offset,
            }),
          }),
        }
      }
      case "read": {
        const normalizedReadArgs = this.normalizeReadToolArgs(args)
        return {
          case: "readToolCall" as const,
          value: create(ReadToolCallSchema, {
            args: create(ReadToolArgsSchema, {
              path: normalizedReadArgs.path,
              offset: normalizedReadArgs.offset,
              limit: normalizedReadArgs.limit,
              includeLineNumbers: normalizedReadArgs.includeLineNumbers,
            }),
          }),
        }
      }
      case "update_todos": {
        const merge = this.parseBooleanFlag(args.merge)
        const todos = Array.isArray(args.todos)
          ? args.todos
              .map((entry, index) => {
                if (!entry || typeof entry !== "object") return undefined
                const item = entry as Record<string, unknown>
                const status = this.normalizeTodoStatusEnum(item.status)
                return {
                  id:
                    safeString(item.id || item.todo_id || item.todoId).trim() ||
                    `todo_${Date.now()}_${index}`,
                  content: safeString(item.content || item.text || item.title),
                  status,
                  createdAt: BigInt(
                    Number(item.createdAt ?? item.created_at) || Date.now()
                  ),
                  updatedAt: BigInt(
                    Number(item.updatedAt ?? item.updated_at) || Date.now()
                  ),
                  dependencies: Array.isArray(item.dependencies)
                    ? item.dependencies
                        .map((dep) => safeString(dep).trim())
                        .filter((dep) => dep.length > 0)
                    : [],
                }
              })
              .filter((item) => !!item)
          : []
        return {
          case: "updateTodosToolCall" as const,
          value: create(UpdateTodosToolCallSchema, {
            args: create(UpdateTodosArgsSchema, {
              todos: todos,
              merge,
            }),
          }),
        }
      }
      case "read_todos": {
        const statusFilterRaw = Array.isArray(args.statusFilter)
          ? args.statusFilter
          : Array.isArray(args.status_filter)
            ? args.status_filter
            : []
        const statusFilter = statusFilterRaw
          .map((status) => this.normalizeTodoStatusEnum(status))
          .filter((status) => Number.isFinite(status))
        const rawIdFilter = args.idFilter ?? args.id_filter
        const idFilter = Array.isArray(rawIdFilter)
          ? rawIdFilter
              .map((id: unknown) => safeString(id).trim())
              .filter((id: string) => id.length > 0)
          : []
        return {
          case: "readTodosToolCall" as const,
          value: create(ReadTodosToolCallSchema, {
            args: create(ReadTodosArgsSchema, {
              statusFilter,
              idFilter,
            }),
          }),
        }
      }
      case "edit":
        return {
          case: "editToolCall" as const,
          value: create(EditToolCallSchema, {
            args: create(EditArgsSchema, {
              path: safeString(args.path),
            }),
          }),
        }
      case "ls": {
        const path = this.resolveLsPath(args)
        return {
          case: "lsToolCall" as const,
          value: create(LsToolCallSchema, {
            args: create(LsArgsSchema, { path }),
          }),
        }
      }
      case "read_lints": {
        const paths =
          this.toStringArray(args.paths).length > 0
            ? this.toStringArray(args.paths)
            : safeString(args.path).trim()
              ? [safeString(args.path).trim()]
              : []
        return {
          case: "readLintsToolCall" as const,
          value: create(ReadLintsToolCallSchema, {
            args: create(ReadLintsToolArgsSchema, { paths }),
          }),
        }
      }
      case "fix_lints":
        return {
          case: "truncatedToolCall" as const,
          value: create(TruncatedToolCallSchema, {
            args: create(TruncatedToolCallArgsSchema, {}),
          }),
        }
      case "mcp": {
        const { name, toolName, providerIdentifier, rawArgs } =
          this.resolveMcpCallFields(args)
        return {
          case: "mcpToolCall" as const,
          value: create(McpToolCallSchema, {
            args: create(McpArgsSchema, {
              name,
              toolName,
              providerIdentifier,
              args: this.toProtoValueMap(rawArgs),
              toolCallId: callId,
            }),
          }),
        }
      }
      case "execute_hook":
        return {
          case: "truncatedToolCall" as const,
          value: create(TruncatedToolCallSchema, {
            args: create(TruncatedToolCallArgsSchema, {}),
          }),
        }
      case "sem_search": {
        const targetDirectories =
          this.toStringArray(args.targetDirectories).length > 0
            ? this.toStringArray(args.targetDirectories)
            : this.toStringArray(args.target_directories)
        return {
          case: "semSearchToolCall" as const,
          value: create(SemSearchToolCallSchema, {
            args: create(SemSearchToolArgsSchema, {
              query: safeString(
                args.query || args.symbol || args.search_term || args.searchTerm
              ),
              targetDirectories,
              explanation: safeString(args.explanation),
            }),
          }),
        }
      }
      case "create_plan":
        return {
          case: "createPlanToolCall" as const,
          value: create(CreatePlanToolCallSchema, {
            args: this.buildCreatePlanArgs(args),
          }),
        }
      case "web_search":
        return {
          case: "webSearchToolCall" as const,
          value: create(WebSearchToolCallSchema, {
            args: create(WebSearchArgsSchema, {
              searchTerm: safeString(
                args.query || args.search_term || args.searchTerm
              ),
              toolCallId: callId,
            }),
          }),
        }
      case "task":
        return {
          case: "taskToolCall" as const,
          value: create(TaskToolCallSchema, {
            args: this.buildTaskArgs(args),
          }),
        }
      case "list_mcp_resources":
        return {
          case: "listMcpResourcesToolCall" as const,
          value: create(ListMcpResourcesToolCallSchema, {
            args: create(ListMcpResourcesExecArgsSchema, {
              server: safeString(
                args.serverName || args.server || args.server_name
              ),
            }),
          }),
        }
      case "read_mcp_resource":
        return {
          case: "readMcpResourceToolCall" as const,
          value: create(ReadMcpResourceToolCallSchema, {
            args: create(ReadMcpResourceExecArgsSchema, {
              server: safeString(
                args.serverName || args.server || args.server_name
              ),
              uri: safeString(args.uri),
              downloadPath:
                safeString(args.downloadPath || args.download_path).trim() ||
                undefined,
            }),
          }),
        }
      case "get_mcp_tools":
        return {
          case: "getMcpToolsToolCall" as const,
          value: create(GetMcpToolsToolCallSchema, {
            args: create(GetMcpToolsArgsSchema, {
              server:
                safeString(
                  args.server ||
                    args.serverName ||
                    args.server_name ||
                    args.providerIdentifier ||
                    args.provider_identifier
                ).trim() || undefined,
              toolName:
                safeString(
                  args.toolName || args.tool_name || args.name
                ).trim() || undefined,
              pattern: safeString(args.pattern).trim() || undefined,
              toolCallId: callId,
            }),
          }),
        }
      case "apply_agent_diff":
        return {
          case: "applyAgentDiffToolCall" as const,
          value: create(ApplyAgentDiffToolCallSchema, {
            args: create(ApplyAgentDiffArgsSchema, {
              agentId: safeString(args.agent_id || args.agentId),
            }),
          }),
        }
      case "ask_question": {
        const normalizedAskQuestionArgs = this.normalizeAskQuestionArgs(
          args,
          callId
        )
        return {
          case: "askQuestionToolCall" as const,
          value: create(AskQuestionToolCallSchema, {
            args: create(AskQuestionArgsSchema, normalizedAskQuestionArgs),
          }),
        }
      }
      case "fetch":
        return {
          case: "fetchToolCall" as const,
          value: create(FetchToolCallSchema, {
            args: create(FetchArgsSchema, {
              url: safeString(args.url),
              toolCallId: callId,
            }),
          }),
        }
      case "switch_mode":
        return {
          case: "switchModeToolCall" as const,
          value: create(SwitchModeToolCallSchema, {
            args: create(SwitchModeArgsSchema, {
              targetModeId: safeString(
                args.targetModeId || args.target_mode_id
              ),
              explanation: safeString(args.explanation) || undefined,
              toolCallId: callId,
            }),
          }),
        }
      case "exa_search": {
        const _numResultsRaw = Number(args.numResults || args.num_results || 0)
        const _numResults = Number.isFinite(_numResultsRaw)
          ? Math.max(0, Math.floor(_numResultsRaw))
          : 0
        return {
          case: "webSearchToolCall" as const,
          value: create(WebSearchToolCallSchema, {
            args: create(WebSearchArgsSchema, {
              searchTerm: safeString(
                args.query || args.searchTerm || args.search_term
              ),
              toolCallId: callId,
            }),
          }),
        }
      }
      case "exa_fetch":
        return {
          case: "webFetchToolCall" as const,
          value: create(WebFetchToolCallSchema, {
            args: create(WebFetchArgsSchema, {
              url: safeString(
                args.url || (Array.isArray(args.ids) ? args.ids[0] : "")
              ),
              toolCallId: callId,
            }),
          }),
        }
      // ─── New v2.6.13 Tool Call Builders ────────────────────────────
      case "await":
        return {
          case: "awaitToolCall" as const,
          value: create(AwaitToolCallSchema, {
            args: create(AwaitArgsSchema, {
              taskId: safeString(args.taskId || args.task_id),
              blockUntilMs: safeUint32(
                args.blockUntilMs ?? args.block_until_ms,
                30000
              ),
              regex: safeString(args.regex) || undefined,
            }),
          }),
        }
      case "ai_attribution":
        return {
          case: "aiAttributionToolCall" as const,
          value: create(AiAttributionToolCallSchema, {
            args: create(AiAttributionArgsSchema, {
              filePaths: this.toStringArray(args.file_paths || args.filePaths),
              commitHashes: this.toStringArray(
                args.commit_hashes || args.commitHashes
              ),
              startLine: Number(args.start_line ?? args.startLine) || undefined,
              endLine: Number(args.end_line ?? args.endLine) || undefined,
              outputMode:
                safeString(args.output_mode || args.outputMode) || undefined,
              maxCommits:
                Number(args.max_commits ?? args.maxCommits) || undefined,
              includeLineRanges:
                Boolean(args.include_line_ranges ?? args.includeLineRanges) ||
                undefined,
            }),
          }),
        }
      case "mcp_auth":
        return {
          case: "mcpAuthToolCall" as const,
          value: create(McpAuthToolCallSchema, {
            args: create(McpAuthArgsSchema, {
              serverIdentifier: safeString(
                args.server_identifier || args.serverIdentifier
              ),
              toolCallId: callId,
            }),
          }),
        }
      case "pr_management": {
        const prAction: { action?: PrManagementArgs["action"] } = {}
        if (args.create_pr || args.createPr) {
          const cp = (args.create_pr || args.createPr) as Record<
            string,
            unknown
          >
          prAction.action = {
            case: "createPr" as const,
            value: create(CreatePrActionSchema, {
              title: safeString(cp.title),
              body: safeString(cp.body),
              baseBranch:
                safeString(cp.base_branch || cp.baseBranch) || undefined,
              draft: (cp.draft as boolean) ?? undefined,
            }),
          }
        } else if (args.update_pr || args.updatePr) {
          const up = (args.update_pr || args.updatePr) as Record<
            string,
            unknown
          >
          prAction.action = {
            case: "updatePr" as const,
            value: create(UpdatePrActionSchema, {
              prUrl: safeString(up.pr_url || up.prUrl) || undefined,
              title: safeString(up.title) || undefined,
              body: safeString(up.body) || undefined,
            }),
          }
        }
        return {
          case: "prManagementToolCall" as const,
          value: create(PrManagementToolCallSchema, {
            args: create(PrManagementArgsSchema, {
              toolCallId: callId,
              ...prAction,
            }),
          }),
        }
      }
      case "blame_by_file_path":
        return {
          case: "blameByFilePathToolCall" as const,
          value: create(BlameByFilePathToolCallSchema, {
            args: create(BlameByFilePathArgsSchema, {
              filePath: safeString(args.filePath || args.file_path),
              startLine: this.parseOptionalNonNegativeInt(
                args.startLine ?? args.start_line
              ),
              endLine: this.parseOptionalNonNegativeInt(
                args.endLine ?? args.end_line
              ),
            }),
          }),
        }
      case "report_bug":
        return {
          case: "reportBugToolCall" as const,
          value: create(ReportBugToolCallSchema, {
            args: create(ReportBugArgsSchema, {
              title: safeString(args.title),
              file: safeString(
                args.file || args.path || args.filePath || args.file_path
              ),
              startLine:
                this.parseOptionalNonNegativeInt(
                  args.startLine ?? args.start_line
                ) ?? 0,
              endLine:
                this.parseOptionalNonNegativeInt(
                  args.endLine ?? args.end_line
                ) ?? 0,
              description: safeString(args.description),
              severity: safeString(args.severity),
              category: safeString(args.category),
              rationale: safeString(args.rationale),
            }),
          }),
        }
      case "set_active_branch":
        return {
          case: "setActiveBranchToolCall" as const,
          value: create(SetActiveBranchToolCallSchema, {
            args: create(SetActiveBranchArgsSchema, {
              path: safeString(args.path),
              branchName: safeString(args.branchName || args.branch_name),
            }),
          }),
        }
      case "generate_image": {
        const referenceImagePaths =
          this.toStringArray(args.referenceImagePaths).length > 0
            ? this.toStringArray(args.referenceImagePaths)
            : this.toStringArray(args.reference_image_paths)
        return {
          case: "generateImageToolCall" as const,
          value: create(GenerateImageToolCallSchema, {
            args: create(GenerateImageArgsSchema, {
              description: safeString(args.prompt || args.description),
              filePath:
                safeString(args.filePath || args.file_path) || undefined,
              referenceImagePaths,
            }),
          }),
        }
      }
      case "record_screen": {
        const mode = this.parseRecordScreenMode(args.mode)
        const saveAsFilename = safeString(
          args.saveAsFilename || args.save_as_filename
        ).trim()
        return {
          case: "recordScreenToolCall" as const,
          value: create(RecordScreenToolCallSchema, {
            args: create(RecordScreenArgsSchema, {
              mode,
              toolCallId: callId,
              saveAsFilename: saveAsFilename || undefined,
            }),
          }),
        }
      }
      case "computer_use": {
        const actions = Array.isArray(args.actions) ? args.actions : []
        return {
          case: "computerUseToolCall" as const,
          value: create(ComputerUseToolCallSchema, {
            args: create(ComputerUseArgsSchema, {
              toolCallId: callId,
              actions: actions,
            }),
          }),
        }
      }
      case "write_shell_stdin":
        return {
          case: "writeShellStdinToolCall" as const,
          value: create(WriteShellStdinToolCallSchema, {
            args: create(WriteShellStdinArgsSchema, {
              shellId: safeUint32(args.shellId ?? args.shell_id, 0),
              chars: safeString(args.data || args.chars),
            }),
          }),
        }
      case "reflect":
        return {
          case: "reflectToolCall" as const,
          value: create(ReflectToolCallSchema, {
            args: this.buildReflectArgs(args, callId),
          }),
        }
      case "setup_vm_environment":
        return {
          case: "setupVmEnvironmentToolCall" as const,
          value: create(SetupVmEnvironmentToolCallSchema, {
            args: create(SetupVmEnvironmentArgsSchema, {
              installCommand: safeString(
                args.installCommand || args.install_command
              ),
              startCommand: safeString(args.startCommand || args.start_command),
            }),
          }),
        }
      case "truncated":
        return {
          case: "truncatedToolCall" as const,
          value: create(TruncatedToolCallSchema, {
            args: create(TruncatedToolCallArgsSchema, {}),
          }),
        }
      case "start_grind_execution":
        return {
          case: "startGrindExecutionToolCall" as const,
          value: create(StartGrindExecutionToolCallSchema, {
            args: create(StartGrindExecutionArgsSchema, {
              explanation: safeString(args.explanation) || undefined,
              toolCallId: callId,
            }),
          }),
        }
      case "start_grind_planning":
        return {
          case: "startGrindPlanningToolCall" as const,
          value: create(StartGrindPlanningToolCallSchema, {
            args: create(StartGrindPlanningArgsSchema, {
              explanation: safeString(args.explanation) || undefined,
              toolCallId: callId,
            }),
          }),
        }
      case "web_fetch":
        return {
          case: "webFetchToolCall" as const,
          value: create(WebFetchToolCallSchema, {
            args: create(WebFetchArgsSchema, {
              url: this.resolveWebFetchUrl(args),
              toolCallId: callId,
            }),
          }),
        }
      case "report_bugfix_results": {
        const results = this.normalizeBugfixResultItems(args.results)
        return {
          case: "reportBugfixResultsToolCall" as const,
          value: create(ReportBugfixResultsToolCallSchema, {
            args: create(ReportBugfixResultsArgsSchema, {
              summary: safeString(args.summary),
              results: results,
            }),
          }),
        }
      }
      default:
        this.logger.warn(
          `Unknown ToolCall type "${toolName}", defaulting to truncatedToolCall`
        )
        return {
          case: "truncatedToolCall" as const,
          value: create(TruncatedToolCallSchema, {
            args: create(TruncatedToolCallArgsSchema, {}),
          }),
        }
    }
  }

  /**
   * 构建带结果的 ToolCall V2
   * 正确填充 ToolCall.result 字段
   */
  private buildToolCallV2WithResult(
    toolName: string,
    callId: string,
    args: Record<string, unknown>,
    result: string,
    extraData?: ToolCompletionExtraData,
    toolFamilyHint?: ToolFamily
  ) {
    const toolOneOf = this.buildToolCallWithResult(
      toolName,
      callId,
      args,
      result,
      extraData,
      toolFamilyHint
    )
    return create(ToolCallSchema, {
      tool: toolOneOf,
    })
  }

  /**
   * 构建带 result 的 ToolCall oneof
   * 根据工具类型填充对应的 Result 消息
   */
  private buildToolCallWithResult(
    toolName: string,
    callId: string,
    args: Record<string, unknown>,
    result: string,
    extraData?: ToolCompletionExtraData,
    toolFamilyHint?: ToolFamily
  ): ToolCallOneOf {
    const family = this.resolveToolFamily(toolName, toolFamilyHint)
    const status = this.detectToolResultStatus(result, extraData)
    const statusMessage =
      extraData?.toolResultState?.message || this.extractStatusMessage(result)
    const asStringArray = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
            .map((item) => safeString(item).trim())
            .filter((item) => item.length > 0)
        : []
    const asInt = (value: unknown, fallback = 0): number => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) return fallback
      return Math.max(0, Math.floor(numeric))
    }
    const normalizeAskQuestionAnswers = (
      value: unknown
    ): Array<{
      questionId: string
      selectedOptionIds: string[]
      freeformText: string
    }> => {
      if (!Array.isArray(value)) return []
      return value
        .map((entry) => {
          if (!entry || typeof entry !== "object") return undefined
          const answer = entry as Record<string, unknown>
          return {
            questionId: safeString(
              answer.questionId || answer.question_id
            ).trim(),
            selectedOptionIds: asStringArray(
              answer.selectedOptionIds || answer.selected_option_ids
            ),
            freeformText: safeString(
              answer.freeformText || answer.freeform_text
            ),
          }
        })
        .filter(
          (
            entry
          ): entry is {
            questionId: string
            selectedOptionIds: string[]
            freeformText: string
          } => !!entry
        )
    }
    const normalizeTodoItems = (
      value: unknown
    ): Array<{
      id: string
      content: string
      status: number
      createdAt: bigint
      updatedAt: bigint
      dependencies: string[]
    }> => {
      if (!Array.isArray(value)) return []
      const nowTs = Date.now()
      const todos: Array<{
        id: string
        content: string
        status: number
        createdAt: bigint
        updatedAt: bigint
        dependencies: string[]
      }> = []
      for (const [index, entry] of value.entries()) {
        if (!entry || typeof entry !== "object") continue
        const item = entry as Record<string, unknown>
        const id =
          safeString(item.id || item.todo_id || item.todoId).trim() ||
          `todo_${nowTs}_${index}`
        const content = safeString(
          item.content || item.text || item.title
        ).trim()
        const createdAtRaw = Number(item.createdAt ?? item.created_at)
        const updatedAtRaw = Number(item.updatedAt ?? item.updated_at)
        todos.push({
          id,
          content,
          status: this.normalizeTodoStatusEnum(item.status),
          createdAt:
            Number.isFinite(createdAtRaw) && createdAtRaw > 0
              ? BigInt(Math.floor(createdAtRaw))
              : BigInt(nowTs),
          updatedAt:
            Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
              ? BigInt(Math.floor(updatedAtRaw))
              : BigInt(nowTs),
          dependencies: asStringArray(
            item.dependencies || item.depends_on || item.dependsOn
          ),
        })
      }
      return todos
    }

    if (family === "shell" || family === "background_shell_spawn") {
      const shellResult = extraData?.shellResult
      const command = safeString(args.command)
      const workingDirectory = safeString(args.cwd || args.working_directory)

      let resultOneOf: ShellResult["result"]
      if (status === "timeout") {
        resultOneOf = {
          case: "timeout" as const,
          value: create(ShellTimeoutSchema, {
            command,
            workingDirectory,
            timeoutMs: normalizeShellTimeoutMs(args.timeout, 30_000),
          }),
        }
      } else if (status === "rejected") {
        resultOneOf = {
          case: "rejected" as const,
          value: create(ShellRejectedSchema, {
            command,
            workingDirectory,
            reason: statusMessage || "Shell command rejected",
            isReadonly: false,
          }),
        }
      } else if (status === "permission_denied") {
        resultOneOf = {
          case: "permissionDenied" as const,
          value: create(ShellPermissionDeniedSchema, {
            command,
            workingDirectory,
            error: statusMessage || "Permission denied",
            isReadonly: false,
          }),
        }
      } else if (status === "spawn_error") {
        resultOneOf = {
          case: "spawnError" as const,
          value: create(ShellSpawnErrorSchema, {
            command,
            workingDirectory,
            error: statusMessage || "Failed to spawn process",
          }),
        }
      } else if (
        status === "failure" ||
        status === "error" ||
        status === "aborted" ||
        status === "file_not_found" ||
        status === "invalid_file"
      ) {
        resultOneOf = {
          case: "failure" as const,
          value: create(ShellFailureSchema, {
            command,
            workingDirectory,
            exitCode: shellResult?.exitCode ?? 1,
            stdout: shellResult?.stdout || "",
            stderr: shellResult?.stderr || statusMessage || result,
            outputLocation: this.normalizeOutputLocation(
              shellResult?.outputLocation
            ),
            interleavedOutput: shellResult?.interleavedOutput || undefined,
            abortReason: this.normalizeShellAbortReason(
              shellResult?.abortReason
            ),
            aborted: shellResult?.aborted ?? status === "aborted",
            localExecutionTimeMs: this.parseOptionalNonNegativeInt(
              shellResult?.localExecutionTimeMs
            ),
          }),
        }
      } else {
        resultOneOf = {
          case: "success" as const,
          value: create(ShellSuccessSchema, {
            command,
            workingDirectory,
            exitCode: shellResult?.exitCode ?? 0,
            stdout: shellResult?.stdout || result,
            stderr: shellResult?.stderr || "",
            outputLocation: this.normalizeOutputLocation(
              shellResult?.outputLocation
            ),
            shellId: this.parseOptionalNonNegativeInt(shellResult?.shellId),
            interleavedOutput: shellResult?.interleavedOutput || undefined,
            pid: this.parseOptionalNonNegativeInt(shellResult?.pid),
            msToWait: this.parseOptionalNonNegativeInt(shellResult?.msToWait),
            localExecutionTimeMs: this.parseOptionalNonNegativeInt(
              shellResult?.localExecutionTimeMs
            ),
            backgroundReason: this.normalizeShellBackgroundReason(
              shellResult?.backgroundReason
            ),
          }),
        }
      }

      return {
        case: "shellToolCall" as const,
        value: create(ShellToolCallSchema, {
          args: this.buildShellArgsMessage(callId, args, shellResult),
          result: create(ShellResultSchema, {
            result: resultOneOf,
            sandboxPolicy:
              shellResult?.requestedSandboxPolicy &&
              this.parseOptionalNonNegativeInt(
                shellResult.requestedSandboxPolicy.type
              ) !== undefined
                ? create(SandboxPolicySchema, {
                    type: this.parseOptionalNonNegativeInt(
                      shellResult.requestedSandboxPolicy.type
                    ) as SandboxPolicy_Type,
                  })
                : undefined,
            isBackground: this.parseBooleanFlag(shellResult?.isBackground),
            terminalsFolder:
              safeString(shellResult?.terminalsFolder).trim() || undefined,
            pid: this.parseOptionalNonNegativeInt(shellResult?.pid),
          }),
        }),
      }
    }

    if (family === "edit") {
      const path = safeString(args.path)
      let editResultOneOf: EditResult["result"]
      if (status === "success") {
        editResultOneOf = {
          case: "success" as const,
          value: create(EditSuccessSchema, {
            path,
            linesAdded: extraData?.editSuccess?.linesAdded,
            linesRemoved: extraData?.editSuccess?.linesRemoved,
            diffString: extraData?.editSuccess?.diffString,
            beforeFullFileContent: extraData?.beforeContent,
            afterFullFileContent: extraData?.afterContent || result,
            message: extraData?.editSuccess?.message,
          }),
        }
      } else if (status === "file_not_found") {
        editResultOneOf = {
          case: "fileNotFound" as const,
          value: create(EditFileNotFoundSchema, { path }),
        }
      } else if (status === "permission_denied") {
        editResultOneOf = {
          case: "writePermissionDenied" as const,
          value: create(EditWritePermissionDeniedSchema, {
            path,
            error: statusMessage || "Permission denied",
            isReadonly: false,
          }),
        }
      } else if (status === "rejected") {
        editResultOneOf = {
          case: "rejected" as const,
          value: create(EditRejectedSchema, {
            path,
            reason: statusMessage || "Edit rejected",
          }),
        }
      } else {
        editResultOneOf = {
          case: "error" as const,
          value: create(EditErrorSchema, {
            path,
            error: statusMessage || "Edit failed",
            modelVisibleError: statusMessage || undefined,
          }),
        }
      }

      return {
        case: "editToolCall" as const,
        value: create(EditToolCallSchema, {
          args: create(EditArgsSchema, { path }),
          result: create(EditResultSchema, {
            result: editResultOneOf,
          }),
        }),
      }
    }

    if (family === "read") {
      const normalizedReadArgs = this.normalizeReadToolArgs(args)
      const readSuccess = extraData?.readSuccess
      const hasBinaryOutput = readSuccess?.data instanceof Uint8Array
      const successContent =
        typeof readSuccess?.content === "string" ? readSuccess.content : result
      const successData = hasBinaryOutput ? readSuccess.data : undefined
      const resolvedPath = safeString(
        readSuccess?.path || normalizedReadArgs.path
      ).trim()
      const explicitTotalLines = this.parseOptionalNonNegativeInt(
        readSuccess?.totalLines
      )
      const inferredTotalLines =
        hasBinaryOutput && successData
          ? 0
          : successContent
            ? successContent.split("\n").length
            : 0
      const totalLines = explicitTotalLines ?? inferredTotalLines
      const explicitFileSize = this.parseOptionalNonNegativeInt(
        readSuccess?.fileSize
      )
      const inferredFileSize =
        hasBinaryOutput && successData
          ? successData.length
          : Buffer.byteLength(successContent || "", "utf-8")
      const fileSize = Math.min(
        explicitFileSize ?? inferredFileSize,
        0xffffffff
      )
      const truncated = this.parseBooleanFlag(readSuccess?.truncated)
      const readRange =
        normalizedReadArgs.offset !== undefined ||
        normalizedReadArgs.limit !== undefined
          ? create(ReadRangeSchema, {
              startLine:
                normalizedReadArgs.offset !== undefined
                  ? normalizedReadArgs.offset + 1
                  : 1,
              endLine:
                normalizedReadArgs.limit !== undefined
                  ? (normalizedReadArgs.offset ?? 0) + normalizedReadArgs.limit
                  : totalLines,
            })
          : undefined
      const relatedCursorRulePaths = Array.isArray(
        readSuccess?.relatedCursorRulePaths
      )
        ? readSuccess.relatedCursorRulePaths
            .map((entry) => safeString(entry).trim())
            .filter((entry) => entry.length > 0)
        : []
      const relatedCursorRules = Array.isArray(readSuccess?.relatedCursorRules)
        ? readSuccess.relatedCursorRules
            .filter((entry) => !!entry && typeof entry === "object")
            .map((entry) => create(CursorRuleSchema, entry))
        : []
      const readResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReadToolSuccessSchema, {
                output:
                  hasBinaryOutput && successData
                    ? {
                        case: "data" as const,
                        value: successData,
                      }
                    : {
                        case: "content" as const,
                        value: successContent,
                      },
                path: resolvedPath,
                totalLines,
                fileSize,
                isEmpty:
                  hasBinaryOutput && successData
                    ? successData.length === 0
                    : successContent.length === 0,
                exceededLimit: truncated,
                readRange,
                includeLineNumbers: normalizedReadArgs.includeLineNumbers,
                relatedCursorRulePaths,
                relatedCursorRules,
              }),
            }
          : {
              case: "error" as const,
              value: create(ReadToolErrorSchema, {
                errorMessage: statusMessage || "Read failed",
              }),
            }

      return {
        case: "readToolCall" as const,
        value: create(ReadToolCallSchema, {
          args: create(ReadToolArgsSchema, {
            path: normalizedReadArgs.path,
            offset: normalizedReadArgs.offset,
            limit: normalizedReadArgs.limit,
            includeLineNumbers: normalizedReadArgs.includeLineNumbers,
          }),
          result: create(ReadToolResultSchema, {
            result: readResultOneOf,
          }),
        }),
      }
    }

    if (family === "ls") {
      const path = this.resolveLsPath(args)
      const lsTreeFromExec = this.buildLsDirectoryTreeNode(
        extraData?.lsDirectoryTreeRoot,
        path
      )
      let lsResultOneOf: LsResult["result"]
      if (status === "success") {
        lsResultOneOf = {
          case: "success" as const,
          value: create(LsSuccessSchema, {
            directoryTreeRoot: lsTreeFromExec,
          }),
        }
      } else if (status === "timeout") {
        lsResultOneOf = {
          case: "timeout" as const,
          value: create(LsTimeoutSchema, {
            directoryTreeRoot: lsTreeFromExec,
          }),
        }
      } else if (status === "rejected") {
        lsResultOneOf = {
          case: "rejected" as const,
          value: create(LsRejectedSchema, {
            path,
            reason: statusMessage || "ls rejected",
          }),
        }
      } else {
        lsResultOneOf = {
          case: "error" as const,
          value: create(LsErrorSchema, {
            path,
            error: statusMessage || "ls failed",
          }),
        }
      }

      return {
        case: "lsToolCall" as const,
        value: create(LsToolCallSchema, {
          args: create(LsArgsSchema, { path }),
          result: create(LsResultSchema, {
            result: lsResultOneOf,
          }),
        }),
      }
    }

    if (family === "grep") {
      const normalizedGrepArgs = this.normalizeGrepCallArgs(args)
      const grepSuccess = extraData?.grepSuccess
      const grepSuccessRecord =
        grepSuccess && typeof grepSuccess === "object"
          ? (grepSuccess as Record<string, unknown>)
          : undefined
      const workspaceResultsCandidate =
        grepSuccessRecord?.workspaceResults ??
        grepSuccessRecord?.workspace_results
      const activeEditorResultCandidate =
        grepSuccessRecord?.activeEditorResult ??
        grepSuccessRecord?.active_editor_result
      const normalizedWorkspaceResults = this.normalizeGrepWorkspaceResults(
        workspaceResultsCandidate
      )
      const normalizedActiveEditorResult = this.normalizeGrepUnionResult(
        activeEditorResultCandidate
      )
      const pattern = safeString(
        normalizedGrepArgs.pattern || grepSuccess?.pattern
      )
      const path = safeString(normalizedGrepArgs.path || grepSuccess?.path)
      const outputMode = safeString(
        normalizedGrepArgs.outputMode ??
          grepSuccessRecord?.outputMode ??
          grepSuccessRecord?.output_mode
      )
      const grepResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(GrepSuccessSchema, {
                pattern,
                path,
                outputMode,
                workspaceResults: normalizedWorkspaceResults,
                activeEditorResult: normalizedActiveEditorResult,
              }),
            }
          : {
              case: "error" as const,
              value: create(GrepErrorSchema, {
                error: statusMessage || "grep failed",
              }),
            }

      return {
        case: "grepToolCall" as const,
        value: create(GrepToolCallSchema, {
          args: create(GrepArgsSchema, {
            pattern,
            path: path || undefined,
            glob: normalizedGrepArgs.glob,
            outputMode: outputMode || undefined,
            caseInsensitive: normalizedGrepArgs.caseInsensitive,
            type: normalizedGrepArgs.type,
            headLimit: normalizedGrepArgs.headLimit,
            offset: normalizedGrepArgs.offset,
          }),
          result: create(GrepResultSchema, {
            result: grepResultOneOf,
          }),
        }),
      }
    }

    if (family === "delete") {
      const deleteSuccess = extraData?.deleteSuccess
      const path = safeString(deleteSuccess?.path || args.path)
      const deletedFile = safeString(deleteSuccess?.deletedFile || path)
      const rawFileSize = deleteSuccess?.fileSize
      let fileSize = 0n
      if (typeof rawFileSize === "bigint") {
        fileSize = rawFileSize >= 0n ? rawFileSize : 0n
      } else {
        const numericFileSize = Number(rawFileSize)
        if (Number.isFinite(numericFileSize) && numericFileSize >= 0) {
          fileSize = BigInt(Math.floor(numericFileSize))
        }
      }
      const prevContent = safeString(deleteSuccess?.prevContent)

      let deleteResultOneOf: DeleteResult["result"]
      if (status === "success") {
        deleteResultOneOf = {
          case: "success" as const,
          value: create(DeleteSuccessSchema, {
            path,
            deletedFile,
            fileSize,
            prevContent,
          }),
        }
      } else if (status === "file_not_found") {
        deleteResultOneOf = {
          case: "fileNotFound" as const,
          value: create(DeleteFileNotFoundSchema, { path }),
        }
      } else if (status === "invalid_file") {
        deleteResultOneOf = {
          case: "notFile" as const,
          value: create(DeleteNotFileSchema, {
            path,
            actualType: "unknown",
          }),
        }
      } else if (status === "permission_denied") {
        deleteResultOneOf = {
          case: "permissionDenied" as const,
          value: create(DeletePermissionDeniedSchema, {
            path,
            clientVisibleError: statusMessage || "Permission denied",
            isReadonly: false,
          }),
        }
      } else if (status === "rejected") {
        deleteResultOneOf = {
          case: "rejected" as const,
          value: create(DeleteRejectedSchema, {
            path,
            reason: statusMessage || "Delete rejected",
          }),
        }
      } else if (status === "file_busy" || status === "timeout") {
        deleteResultOneOf = {
          case: "fileBusy" as const,
          value: create(DeleteFileBusySchema, { path }),
        }
      } else {
        deleteResultOneOf = {
          case: "error" as const,
          value: create(DeleteErrorSchema, {
            path,
            error: statusMessage || "Delete failed",
          }),
        }
      }

      return {
        case: "deleteToolCall" as const,
        value: create(DeleteToolCallSchema, {
          args: create(DeleteArgsSchema, { path }),
          result: create(DeleteResultSchema, {
            result: deleteResultOneOf,
          }),
        }),
      }
    }

    if (family === "glob") {
      const globArgs = this.normalizeGlobCallArgs(args)
      const pattern = globArgs.pattern
      const path = globArgs.targetDirectory
      const normalizedGlob = this.normalizeGlobFiles(args)
      const globResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(GlobToolSuccessSchema, {
                pattern,
                path,
                files: normalizedGlob.files,
                totalFiles: normalizedGlob.totalFiles,
                clientTruncated: normalizedGlob.clientTruncated,
                ripgrepTruncated: normalizedGlob.ripgrepTruncated,
              }),
            }
          : {
              case: "error" as const,
              value: create(GlobToolErrorSchema, {
                error: statusMessage || "glob failed",
              }),
            }

      return {
        case: "globToolCall" as const,
        value: create(GlobToolCallSchema, {
          args: create(GlobToolArgsSchema, {
            globPattern: pattern,
            targetDirectory: path || undefined,
          }),
          result: create(GlobToolResultSchema, {
            result: globResultOneOf,
          }),
        }),
      }
    }

    if (family === "fetch") {
      const url = safeString(args.url)
      const statusCode = asInt(
        args.statusCode ?? args.status_code,
        status === "success" ? 200 : 0
      )
      const contentType = safeString(args.contentType || args.content_type)
      const fetchResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(FetchSuccessSchema, {
                url,
                content: result,
                statusCode,
                contentType,
              }),
            }
          : {
              case: "error" as const,
              value: create(FetchErrorSchema, {
                url,
                error: statusMessage || "fetch failed",
              }),
            }

      return {
        case: "fetchToolCall" as const,
        value: create(FetchToolCallSchema, {
          args: create(FetchArgsSchema, {
            url,
            toolCallId: callId,
          }),
          result: create(FetchResultSchema, {
            result: fetchResultOneOf,
          }),
        }),
      }
    }

    if (family === "read_lints") {
      const diagnosticsSuccess = extraData?.diagnosticsSuccess
      const paths =
        asStringArray(args.paths).length > 0
          ? asStringArray(args.paths)
          : safeString(args.path)
            ? [safeString(args.path)]
            : []
      const diagnosticsPath = safeString(diagnosticsSuccess?.path).trim()
      const resolvedPaths =
        paths.length > 0 ? paths : diagnosticsPath ? [diagnosticsPath] : []
      const normalizedDiagnosticItems = this.normalizeReadLintsDiagnosticItems(
        diagnosticsSuccess?.diagnostics
      )
      const protoDiagnosticItems = normalizedDiagnosticItems.map((item) =>
        create(DiagnosticItemSchema, {
          severity: item.severity,
          ...(item.range
            ? {
                range: create(DiagnosticRangeSchema, {
                  ...(item.range.start
                    ? { start: create(PositionSchema, item.range.start) }
                    : {}),
                  ...(item.range.end
                    ? { end: create(PositionSchema, item.range.end) }
                    : {}),
                }),
              }
            : {}),
          message: item.message,
          source: item.source,
          code: item.code,
          isStale: item.isStale,
        })
      )
      const primaryDiagnosticsCount =
        this.parseOptionalNonNegativeInt(
          diagnosticsSuccess?.totalDiagnostics
        ) ?? protoDiagnosticItems.length
      const fileDiagnostics = resolvedPaths.map((path, index) =>
        create(FileDiagnosticsSchema, {
          path,
          diagnostics: index === 0 ? protoDiagnosticItems : [],
          diagnosticsCount: index === 0 ? primaryDiagnosticsCount : 0,
        })
      )
      const totalDiagnostics =
        fileDiagnostics.length > 0
          ? fileDiagnostics.reduce(
              (sum, entry) =>
                sum +
                (this.parseOptionalNonNegativeInt(entry.diagnosticsCount) ?? 0),
              0
            )
          : primaryDiagnosticsCount
      const readLintsResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReadLintsToolSuccessSchema, {
                fileDiagnostics,
                totalFiles: fileDiagnostics.length,
                totalDiagnostics,
              }),
            }
          : {
              case: "error" as const,
              value: create(ReadLintsToolErrorSchema, {
                errorMessage: statusMessage || "read_lints failed",
              }),
            }

      return {
        case: "readLintsToolCall" as const,
        value: create(ReadLintsToolCallSchema, {
          args: create(ReadLintsToolArgsSchema, { paths }),
          result: create(ReadLintsToolResultSchema, {
            result: readLintsResultOneOf,
          }),
        }),
      }
    }

    if (family === "fix_lints") {
      const fixLintsResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(TruncatedToolCallSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(TruncatedToolCallErrorSchema, {
                error: statusMessage || "fix_lints failed",
              }),
            }

      return {
        case: "truncatedToolCall" as const,
        value: create(TruncatedToolCallSchema, {
          args: create(TruncatedToolCallArgsSchema, {}),
          result: create(TruncatedToolCallResultSchema, {
            result: fixLintsResultOneOf,
          }),
        }),
      }
    }

    if (family === "read_todos") {
      const statusFilterRaw = Array.isArray(args.statusFilter)
        ? args.statusFilter
        : Array.isArray(args.status_filter)
          ? args.status_filter
          : []
      const statusFilter = statusFilterRaw.map((value) =>
        this.normalizeTodoStatusEnum(value)
      )
      const idFilter = asStringArray(args.idFilter || args.id_filter)
      const allTodos = normalizeTodoItems(args.todos)
      const filteredTodos = allTodos.filter((todo) => {
        if (statusFilter.length > 0 && !statusFilter.includes(todo.status)) {
          return false
        }
        if (idFilter.length > 0 && !idFilter.includes(todo.id)) {
          return false
        }
        return true
      })
      const readTodosResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReadTodosSuccessSchema, {
                todos: filteredTodos,
                totalCount: filteredTodos.length,
              }),
            }
          : {
              case: "error" as const,
              value: create(ReadTodosErrorSchema, {
                error: statusMessage || "read_todos failed",
              }),
            }

      return {
        case: "readTodosToolCall" as const,
        value: create(ReadTodosToolCallSchema, {
          args: create(ReadTodosArgsSchema, {
            statusFilter,
            idFilter,
          }),
          result: create(ReadTodosResultSchema, {
            result: readTodosResultOneOf,
          }),
        }),
      }
    }

    if (family === "update_todos") {
      const merge = this.parseBooleanFlag(args.merge)
      const providedTodos = normalizeTodoItems(args.todos)
      const updatedTodos = normalizeTodoItems(
        args.updated_todos || args.updatedTodos || args.todos
      )
      const resultTodos = updatedTodos.length > 0 ? updatedTodos : providedTodos
      const updateTodosResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(UpdateTodosSuccessSchema, {
                todos: resultTodos,
                totalCount: resultTodos.length,
                wasMerge: merge,
              }),
            }
          : {
              case: "error" as const,
              value: create(UpdateTodosErrorSchema, {
                error: statusMessage || "update_todos failed",
              }),
            }

      return {
        case: "updateTodosToolCall" as const,
        value: create(UpdateTodosToolCallSchema, {
          args: create(UpdateTodosArgsSchema, {
            todos: providedTodos,
            merge,
          }),
          result: create(UpdateTodosResultSchema, {
            result: updateTodosResultOneOf,
          }),
        }),
      }
    }

    if (family === "apply_agent_diff") {
      const applyDiffResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ApplyAgentDiffSuccessSchema, {
                appliedChanges: [],
              }),
            }
          : {
              case: "error" as const,
              value: create(ApplyAgentDiffErrorSchema, {
                error: statusMessage || "apply_agent_diff failed",
                appliedChanges: [],
              }),
            }

      return {
        case: "applyAgentDiffToolCall" as const,
        value: create(ApplyAgentDiffToolCallSchema, {
          args: create(ApplyAgentDiffArgsSchema, {
            agentId: safeString(args.agent_id || args.agentId),
          }),
          result: create(ApplyAgentDiffResultSchema, {
            result: applyDiffResultOneOf,
          }),
        }),
      }
    }

    if (family === "ask_question") {
      const projectedCase = extraData?.askQuestionResult?.resultCase
      const projectedAnswers = normalizeAskQuestionAnswers(
        extraData?.askQuestionResult?.answers
      )
      const projectedReason = safeString(
        extraData?.askQuestionResult?.reason
      ).trim()
      const projectedErrorMessage = safeString(
        extraData?.askQuestionResult?.errorMessage
      ).trim()
      let askQuestionResultOneOf: AskQuestionResult["result"]
      if (projectedCase === "success") {
        askQuestionResultOneOf = {
          case: "success" as const,
          value: create(AskQuestionSuccessSchema, {
            answers: projectedAnswers,
          }),
        }
      } else if (projectedCase === "async") {
        askQuestionResultOneOf = {
          case: "async" as const,
          value: create(AskQuestionAsyncSchema, {}),
        }
      } else if (projectedCase === "rejected") {
        askQuestionResultOneOf = {
          case: "rejected" as const,
          value: create(AskQuestionRejectedSchema, {
            reason: projectedReason || statusMessage || "ask_question rejected",
          }),
        }
      } else if (projectedCase === "error") {
        askQuestionResultOneOf = {
          case: "error" as const,
          value: create(AskQuestionErrorSchema, {
            errorMessage:
              projectedErrorMessage || statusMessage || "ask_question failed",
          }),
        }
      } else if (status === "success") {
        askQuestionResultOneOf = {
          case: "success" as const,
          value: create(AskQuestionSuccessSchema, {
            answers: [],
          }),
        }
      } else if (status === "rejected") {
        askQuestionResultOneOf = {
          case: "rejected" as const,
          value: create(AskQuestionRejectedSchema, {
            reason: statusMessage || "ask_question rejected",
          }),
        }
      } else if (status === "timeout") {
        askQuestionResultOneOf = {
          case: "async" as const,
          value: create(AskQuestionAsyncSchema, {}),
        }
      } else {
        askQuestionResultOneOf = {
          case: "error" as const,
          value: create(AskQuestionErrorSchema, {
            errorMessage: statusMessage || "ask_question failed",
          }),
        }
      }

      const normalizedAskQuestionArgs = this.normalizeAskQuestionArgs(
        args,
        callId
      )

      return {
        case: "askQuestionToolCall" as const,
        value: create(AskQuestionToolCallSchema, {
          args: create(AskQuestionArgsSchema, normalizedAskQuestionArgs),
          result: create(AskQuestionResultSchema, {
            result: askQuestionResultOneOf,
          }),
        }),
      }
    }

    if (family === "create_plan") {
      const planUriFromArgs = safeString(args.planUri || args.plan_uri).trim()
      const planUriFromResult =
        this.extractCreatePlanUri(result) ||
        this.extractCreatePlanUri(statusMessage)
      const planUri = planUriFromArgs || planUriFromResult
      const createPlanResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(CreatePlanSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(CreatePlanErrorSchema, {
                error: statusMessage || "create_plan failed",
              }),
            }

      return {
        case: "createPlanToolCall" as const,
        value: create(CreatePlanToolCallSchema, {
          args: this.buildCreatePlanArgs(args),
          result: create(CreatePlanResultSchema, {
            result: createPlanResultOneOf,
            planUri,
          }),
        }),
      }
    }

    if (family === "sem_search") {
      const semSearchResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(SemSearchToolSuccessSchema, {
                results: result,
                codeResults: [],
              }),
            }
          : {
              case: "error" as const,
              value: create(SemSearchToolErrorSchema, {
                errorMessage: statusMessage || "sem_search failed",
              }),
            }

      return {
        case: "semSearchToolCall" as const,
        value: create(SemSearchToolCallSchema, {
          args: create(SemSearchToolArgsSchema, {
            query: safeString(
              args.query || args.symbol || args.search_term || args.searchTerm
            ),
            targetDirectories: asStringArray(args.targetDirectories),
            explanation: safeString(args.explanation),
          }),
          result: create(SemSearchToolResultSchema, {
            result: semSearchResultOneOf,
          }),
        }),
      }
    }

    if (family === "truncated") {
      const truncatedResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(TruncatedToolCallSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(TruncatedToolCallErrorSchema, {
                error: statusMessage || "truncated tool failed",
              }),
            }

      return {
        case: "truncatedToolCall" as const,
        value: create(TruncatedToolCallSchema, {
          args: create(TruncatedToolCallArgsSchema, {}),
          result: create(TruncatedToolCallResultSchema, {
            result: truncatedResultOneOf,
          }),
        }),
      }
    }

    if (family === "execute_hook") {
      const truncatedResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(TruncatedToolCallSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(TruncatedToolCallErrorSchema, {
                error:
                  statusMessage ||
                  `${family} has no dedicated ToolCall oneof in this protocol`,
              }),
            }

      return {
        case: "truncatedToolCall" as const,
        value: create(TruncatedToolCallSchema, {
          args: create(TruncatedToolCallArgsSchema, {}),
          result: create(TruncatedToolCallResultSchema, {
            result: truncatedResultOneOf,
          }),
        }),
      }
    }

    if (family === "reflect") {
      const reflectResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReflectSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(ReflectErrorSchema, {
                error: statusMessage || "reflect failed",
              }),
            }

      return {
        case: "reflectToolCall" as const,
        value: create(ReflectToolCallSchema, {
          args: this.buildReflectArgs(args, callId),
          result: create(ReflectResultSchema, {
            result: reflectResultOneOf,
          }),
        }),
      }
    }

    if (family === "mcp") {
      const {
        name,
        toolName,
        providerIdentifier,
        rawArgs: mcpArgsInput,
      } = this.resolveMcpCallFields(args)
      let mcpResultOneOf: McpToolResult["result"]
      if (status === "success") {
        const contentItems = this.buildMcpResultContentItems(result)
        mcpResultOneOf = {
          case: "success" as const,
          value: create(McpSuccessSchema, {
            content: contentItems,
            isError: false,
          }),
        }
      } else if (status === "rejected") {
        mcpResultOneOf = {
          case: "rejected" as const,
          value: create(McpRejectedSchema, {
            reason: statusMessage || "mcp rejected",
            isReadonly: false,
          }),
        }
      } else if (status === "permission_denied") {
        mcpResultOneOf = {
          case: "permissionDenied" as const,
          value: create(McpPermissionDeniedSchema, {
            error: statusMessage || "permission denied",
            isReadonly: false,
          }),
        }
      } else {
        mcpResultOneOf = {
          case: "error" as const,
          value: create(McpToolErrorSchema, {
            error: statusMessage || "mcp failed",
            readToolDefReminder: "",
          }),
        }
      }
      return {
        case: "mcpToolCall" as const,
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, {
            name,
            args: this.toProtoValueMap(mcpArgsInput),
            toolName,
            providerIdentifier,
            toolCallId: callId,
          }),
          result: create(McpToolResultSchema, {
            result: mcpResultOneOf,
          }),
        }),
      }
    }

    if (family === "get_mcp_tools") {
      const server = safeString(
        args.server ||
          args.serverName ||
          args.server_name ||
          args.providerIdentifier ||
          args.provider_identifier
      ).trim()
      const toolName = safeString(
        args.toolName || args.tool_name || args.name
      ).trim()
      const pattern = safeString(args.pattern).trim()
      const getMcpToolsResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(GetMcpToolsSuccessSchema, {
                content: result,
              }),
            }
          : {
              case: "error" as const,
              value: create(GetMcpToolsErrorSchema, {
                error: statusMessage || "get_mcp_tools failed",
              }),
            }

      return {
        case: "getMcpToolsToolCall" as const,
        value: create(GetMcpToolsToolCallSchema, {
          args: create(GetMcpToolsArgsSchema, {
            server: server || undefined,
            toolName: toolName || undefined,
            pattern: pattern || undefined,
            toolCallId: callId,
          }),
          result: create(GetMcpToolsAgentResultSchema, {
            result: getMcpToolsResultOneOf,
          }),
        }),
      }
    }

    if (family === "read_mcp_resource") {
      const readMcpSuccess = extraData?.readMcpResourceSuccess
      const uri = safeString(readMcpSuccess?.uri || args.uri)
      const server = safeString(
        args.serverName || args.server || args.server_name
      )
      const downloadPath = safeString(
        readMcpSuccess?.downloadPath || args.downloadPath || args.download_path
      ).trim()
      let readMcpResultOneOf: ReadMcpResourceExecResult["result"]
      if (status === "success") {
        const successAnnotations = this.normalizeStringMap(
          readMcpSuccess?.annotations
        )
        const successContent =
          readMcpSuccess?.blob instanceof Uint8Array
            ? ({
                case: "blob" as const,
                value: readMcpSuccess.blob,
              } as const)
            : ({
                case: "text" as const,
                value:
                  typeof readMcpSuccess?.text === "string"
                    ? readMcpSuccess.text
                    : result,
              } as const)

        readMcpResultOneOf = {
          case: "success" as const,
          value: create(ReadMcpResourceSuccessSchema, {
            content: successContent,
            uri,
            name: safeString(readMcpSuccess?.name).trim() || undefined,
            description:
              safeString(readMcpSuccess?.description).trim() || undefined,
            mimeType: safeString(readMcpSuccess?.mimeType).trim() || undefined,
            annotations: successAnnotations,
            downloadPath: downloadPath || undefined,
          }),
        }
      } else if (status === "rejected") {
        readMcpResultOneOf = {
          case: "rejected" as const,
          value: create(ReadMcpResourceRejectedSchema, {
            uri,
            reason: statusMessage || "read_mcp_resource rejected",
          }),
        }
      } else if (status === "file_not_found") {
        readMcpResultOneOf = {
          case: "notFound" as const,
          value: create(ReadMcpResourceNotFoundSchema, {
            uri,
          }),
        }
      } else {
        readMcpResultOneOf = {
          case: "error" as const,
          value: create(ReadMcpResourceErrorSchema, {
            uri,
            error: statusMessage || "read_mcp_resource failed",
          }),
        }
      }

      return {
        case: "readMcpResourceToolCall" as const,
        value: create(ReadMcpResourceToolCallSchema, {
          args: create(ReadMcpResourceExecArgsSchema, {
            server,
            uri,
            downloadPath: downloadPath || undefined,
          }),
          result: create(ReadMcpResourceExecResultSchema, {
            result: readMcpResultOneOf,
          }),
        }),
      }
    }

    if (family === "list_mcp_resources") {
      const listMcpServer = safeString(
        args.serverName || args.server || args.server_name
      )
      let listMcpResultOneOf: ListMcpResourcesExecResult["result"]
      if (status === "success") {
        const resources = this.normalizeListMcpResourceEntries(
          extraData?.listMcpResourcesSuccess?.resources,
          listMcpServer
        )
        listMcpResultOneOf = {
          case: "success" as const,
          value: create(ListMcpResourcesSuccessSchema, {
            resources: resources,
          }),
        }
      } else if (status === "rejected") {
        listMcpResultOneOf = {
          case: "rejected" as const,
          value: create(ListMcpResourcesRejectedSchema, {
            reason: statusMessage || "list_mcp_resources rejected",
          }),
        }
      } else {
        listMcpResultOneOf = {
          case: "error" as const,
          value: create(ListMcpResourcesErrorSchema, {
            error: statusMessage || "list_mcp_resources failed",
          }),
        }
      }

      return {
        case: "listMcpResourcesToolCall" as const,
        value: create(ListMcpResourcesToolCallSchema, {
          args: create(ListMcpResourcesExecArgsSchema, {
            server: listMcpServer,
          }),
          result: create(ListMcpResourcesExecResultSchema, {
            result: listMcpResultOneOf,
          }),
        }),
      }
    }

    if (family === "exa_search") {
      const _numResults = asInt(args.numResults || args.num_results)
      const references = this.normalizeExaSearchReferences(args, result)
      let exaSearchResultOneOf: WebSearchResult["result"]
      if (status === "success") {
        exaSearchResultOneOf = {
          case: "success" as const,
          value: create(WebSearchSuccessSchema, {
            references: references,
          }),
        }
      } else if (status === "rejected") {
        exaSearchResultOneOf = {
          case: "rejected" as const,
          value: create(WebSearchRejectedSchema, {
            reason: statusMessage || "exa_search rejected",
          }),
        }
      } else {
        exaSearchResultOneOf = {
          case: "error" as const,
          value: create(WebSearchErrorSchema, {
            error: statusMessage || "exa_search failed",
          }),
        }
      }

      return {
        case: "webSearchToolCall" as const,
        value: create(WebSearchToolCallSchema, {
          args: create(WebSearchArgsSchema, {
            searchTerm: safeString(
              args.query || args.searchTerm || args.search_term
            ),
            toolCallId: callId,
          }),
          result: create(WebSearchResultSchema, {
            result: exaSearchResultOneOf,
          }),
        }),
      }
    }

    if (family === "exa_fetch") {
      const contents = this.normalizeExaFetchContents(args, result)
      const url = safeString(
        args.url || (Array.isArray(args.ids) ? args.ids[0] : "")
      )
      let exaFetchResultOneOf: WebFetchResult["result"]
      if (status === "success") {
        exaFetchResultOneOf = {
          case: "success" as const,
          value: create(WebFetchSuccessSchema, {
            url,
            markdown:
              typeof contents === "string"
                ? contents
                : typeof contents === "object" && contents !== null
                  ? JSON.stringify(contents)
                  : String(contents ?? ""),
          }),
        }
      } else if (status === "rejected") {
        exaFetchResultOneOf = {
          case: "rejected" as const,
          value: create(WebFetchRejectedSchema, {
            reason: statusMessage || "exa_fetch rejected",
          }),
        }
      } else {
        exaFetchResultOneOf = {
          case: "error" as const,
          value: create(WebFetchErrorSchema, {
            url,
            error: statusMessage || "exa_fetch failed",
          }),
        }
      }

      return {
        case: "webFetchToolCall" as const,
        value: create(WebFetchToolCallSchema, {
          args: create(WebFetchArgsSchema, {
            url,
            toolCallId: callId,
          }),
          result: create(WebFetchResultSchema, {
            result: exaFetchResultOneOf,
          }),
        }),
      }
    }

    if (family === "web_search") {
      const searchTerm = safeString(
        args.query || args.search_term || args.searchTerm
      )
      let webSearchResultOneOf: WebSearchResult["result"]
      if (status === "success") {
        let references = this.parseWebSearchReferences(result)
        if (references.length === 0) {
          references = this.buildWebSearchFallbackReferences(searchTerm, result)
          if (references.length > 0) {
            this.logger.warn(
              `web_search produced no parseable sources; using fallback query reference (query="${searchTerm.slice(0, 120)}")`
            )
          } else {
            this.logger.warn(
              `web_search produced empty sources and empty query; returning success with empty references`
            )
          }
        }
        webSearchResultOneOf = {
          case: "success" as const,
          value: create(WebSearchSuccessSchema, {
            references,
          }),
        }
      } else if (status === "rejected") {
        webSearchResultOneOf = {
          case: "rejected" as const,
          value: create(WebSearchRejectedSchema, {
            reason: statusMessage || "web_search rejected",
          }),
        }
      } else {
        webSearchResultOneOf = {
          case: "error" as const,
          value: create(WebSearchErrorSchema, {
            error: statusMessage || "web_search failed",
          }),
        }
      }

      return {
        case: "webSearchToolCall" as const,
        value: create(WebSearchToolCallSchema, {
          args: create(WebSearchArgsSchema, {
            searchTerm,
            toolCallId: callId,
          }),
          result: create(WebSearchResultSchema, {
            result: webSearchResultOneOf,
          }),
        }),
      }
    }

    if (family === "web_fetch") {
      const url = this.resolveWebFetchUrl(args)
      let webFetchResultOneOf: WebFetchResult["result"]
      if (status === "success") {
        webFetchResultOneOf = {
          case: "success" as const,
          value: create(WebFetchSuccessSchema, {
            url,
            markdown: result,
          }),
        }
      } else if (status === "rejected") {
        webFetchResultOneOf = {
          case: "rejected" as const,
          value: create(WebFetchRejectedSchema, {
            reason: statusMessage || "web_fetch rejected",
          }),
        }
      } else {
        webFetchResultOneOf = {
          case: "error" as const,
          value: create(WebFetchErrorSchema, {
            url,
            error: statusMessage || "web_fetch failed",
          }),
        }
      }

      return {
        case: "webFetchToolCall" as const,
        value: create(WebFetchToolCallSchema, {
          args: create(WebFetchArgsSchema, {
            url,
            toolCallId: callId,
          }),
          result: create(WebFetchResultSchema, {
            result: webFetchResultOneOf,
          }),
        }),
      }
    }

    // ─── New v2.6.13 Completion Handlers ─────────────────────────────

    if (family === "await") {
      const taskIdVal = safeString(args.taskId || args.task_id)
      let awaitResultOneOf: AwaitResult["result"]
      if (status === "success") {
        awaitResultOneOf = {
          case: "success" as const,
          value: create(AwaitSuccessSchema, {
            awaitResult: {
              case: "complete" as const,
              value: create(AwaitTaskCompleteSchema, {
                taskId: taskIdVal,
                runtimeMs: BigInt(extraData?.awaitResult?.runtimeMs ?? 0),
                outputFilePath: safeString(
                  extraData?.awaitResult?.outputFilePath
                ),
                outputLength: BigInt(extraData?.awaitResult?.outputLength ?? 0),
                exitCode: extraData?.awaitResult?.exitCode ?? undefined,
              }),
            },
          }),
        }
      } else {
        awaitResultOneOf = {
          case: "error" as const,
          value: create(AwaitErrorSchema, {
            error: statusMessage || "await failed",
          }),
        }
      }

      return {
        case: "awaitToolCall" as const,
        value: create(AwaitToolCallSchema, {
          args: create(AwaitArgsSchema, {
            taskId: taskIdVal,
            blockUntilMs: safeUint32(
              args.timeoutMs ??
                args.timeout_ms ??
                args.blockUntilMs ??
                args.block_until_ms,
              30000
            ),
          }),
          result: create(AwaitResultSchema, {
            result: awaitResultOneOf,
          }),
        }),
      }
    }

    if (family === "ai_attribution") {
      let aiAttrResultOneOf: AiAttributionResult["result"]
      if (status === "success") {
        aiAttrResultOneOf = {
          case: "success" as const,
          value: create(AiAttributionSuccessSchema, {
            attributionText: result || "",
          }),
        }
      } else {
        aiAttrResultOneOf = {
          case: "error" as const,
          value: create(AiAttributionErrorSchema, {
            error: statusMessage || "ai_attribution failed",
          }),
        }
      }

      return {
        case: "aiAttributionToolCall" as const,
        value: create(AiAttributionToolCallSchema, {
          args: create(AiAttributionArgsSchema, {
            filePaths: this.toStringArray(args.file_paths || args.filePaths),
            commitHashes: this.toStringArray(
              args.commit_hashes || args.commitHashes
            ),
          }),
          result: create(AiAttributionResultSchema, {
            result: aiAttrResultOneOf,
          }),
        }),
      }
    }

    if (family === "mcp_auth") {
      const serverIdentifier = safeString(
        args.server_identifier || args.serverIdentifier
      )
      let mcpAuthResultOneOf: McpAuthResult["result"]
      if (status === "success") {
        mcpAuthResultOneOf = {
          case: "success" as const,
          value: create(McpAuthSuccessSchema, {
            serverIdentifier,
          }),
        }
      } else if (status === "rejected") {
        mcpAuthResultOneOf = {
          case: "rejected" as const,
          value: create(McpAuthRejectedSchema, {
            reason: statusMessage || "mcp_auth rejected",
          }),
        }
      } else {
        mcpAuthResultOneOf = {
          case: "error" as const,
          value: create(McpAuthErrorSchema, {
            error: statusMessage || "mcp_auth failed",
          }),
        }
      }

      return {
        case: "mcpAuthToolCall" as const,
        value: create(McpAuthToolCallSchema, {
          args: create(McpAuthArgsSchema, {
            serverIdentifier,
            toolCallId: callId,
          }),
          result: create(McpAuthResultSchema, {
            result: mcpAuthResultOneOf,
          }),
        }),
      }
    }

    if (family === "pr_management") {
      let prResultOneOf: PrManagementResult["result"]
      if (status === "success") {
        prResultOneOf = {
          case: "success" as const,
          value: create(PrManagementSuccessSchema, {
            prUrl: safeString(extraData?.prResult?.prUrl),
            prNumber: extraData?.prResult?.prNumber ?? 0,
            message: result || "PR created successfully",
          }),
        }
      } else if (status === "rejected") {
        prResultOneOf = {
          case: "rejected" as const,
          value: create(PrManagementRejectedSchema, {
            reason: statusMessage || "pr_management rejected",
          }),
        }
      } else {
        prResultOneOf = {
          case: "error" as const,
          value: create(PrManagementErrorSchema, {
            error: statusMessage || "pr_management failed",
          }),
        }
      }

      return {
        case: "prManagementToolCall" as const,
        value: create(PrManagementToolCallSchema, {
          args: create(PrManagementArgsSchema, {
            toolCallId: callId,
          }),
          result: create(PrManagementResultSchema, {
            result: prResultOneOf,
          }),
        }),
      }
    }

    if (family === "write_shell_stdin") {
      const shellId = safeUint32(args.shellId ?? args.shell_id, 0)
      const writeShellStdinSuccess = extraData?.writeShellStdinSuccess
      const successShellId = safeUint32(
        writeShellStdinSuccess?.shellId,
        shellId
      )
      const terminalFileLengthBeforeInputWritten = safeUint32(
        writeShellStdinSuccess?.terminalFileLengthBeforeInputWritten,
        0
      )
      const writeShellStdinResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(WriteShellStdinSuccessSchema, {
                shellId: successShellId,
                terminalFileLengthBeforeInputWritten,
              }),
            }
          : {
              case: "error" as const,
              value: create(WriteShellStdinErrorSchema, {
                error: statusMessage || "write_shell_stdin failed",
              }),
            }

      return {
        case: "writeShellStdinToolCall" as const,
        value: create(WriteShellStdinToolCallSchema, {
          args: create(WriteShellStdinArgsSchema, {
            shellId,
            chars: safeString(args.data || args.chars),
          }),
          result: create(WriteShellStdinResultSchema, {
            result: writeShellStdinResultOneOf,
          }),
        }),
      }
    }

    if (family === "generate_image") {
      const referenceImagePaths =
        asStringArray(args.referenceImagePaths).length > 0
          ? asStringArray(args.referenceImagePaths)
          : asStringArray(args.reference_image_paths)
      const generateImageResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(GenerateImageSuccessSchema, {
                filePath: safeString(args.filePath || args.file_path),
                imageData: result,
              }),
            }
          : {
              case: "error" as const,
              value: create(GenerateImageErrorSchema, {
                error: statusMessage || "generate_image failed",
              }),
            }

      return {
        case: "generateImageToolCall" as const,
        value: create(GenerateImageToolCallSchema, {
          args: create(GenerateImageArgsSchema, {
            description: safeString(args.prompt || args.description),
            filePath: safeString(args.filePath || args.file_path) || undefined,
            referenceImagePaths,
          }),
          result: create(GenerateImageResultSchema, {
            result: generateImageResultOneOf,
          }),
        }),
      }
    }

    if (family === "record_screen") {
      const mode = this.parseRecordScreenMode(args.mode)
      const saveAsFilename = safeString(
        args.saveAsFilename || args.save_as_filename
      ).trim()
      const recordScreenResultOneOf =
        status === "success"
          ? mode === RecordingMode.SAVE_RECORDING
            ? {
                case: "saveSuccess" as const,
                value: create(RecordScreenSaveSuccessSchema, {
                  path:
                    safeString(
                      args.path ||
                        args.filePath ||
                        args.file_path ||
                        saveAsFilename
                    ) || "",
                  recordingDurationMs: BigInt(
                    asInt(
                      args.recordingDurationMs ||
                        args.durationMs ||
                        args.duration
                    )
                  ),
                }),
              }
            : mode === RecordingMode.DISCARD_RECORDING
              ? {
                  case: "discardSuccess" as const,
                  value: create(RecordScreenDiscardSuccessSchema, {}),
                }
              : {
                  case: "startSuccess" as const,
                  value: create(RecordScreenStartSuccessSchema, {
                    wasPriorRecordingCancelled: false,
                    wasSaveAsFilenameIgnored: false,
                  }),
                }
          : {
              case: "failure" as const,
              value: create(RecordScreenFailureSchema, {
                error: statusMessage || "record_screen failed",
              }),
            }

      return {
        case: "recordScreenToolCall" as const,
        value: create(RecordScreenToolCallSchema, {
          args: create(RecordScreenArgsSchema, {
            mode,
            toolCallId: callId,
            saveAsFilename: saveAsFilename || undefined,
          }),
          result: create(RecordScreenResultSchema, {
            result: recordScreenResultOneOf,
          }),
        }),
      }
    }

    if (family === "blame_by_file_path") {
      const blameResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(BlameByFilePathSuccessSchema, {
                content: result,
              }),
            }
          : {
              case: "error" as const,
              value: create(BlameByFilePathErrorSchema, {
                errorMessage: statusMessage || "blame_by_file_path failed",
              }),
            }

      return {
        case: "blameByFilePathToolCall" as const,
        value: create(BlameByFilePathToolCallSchema, {
          args: create(BlameByFilePathArgsSchema, {
            filePath: safeString(args.filePath || args.file_path),
            startLine: this.parseOptionalNonNegativeInt(
              args.startLine ?? args.start_line
            ),
            endLine: this.parseOptionalNonNegativeInt(
              args.endLine ?? args.end_line
            ),
          }),
          result: create(BlameByFilePathResultSchema, {
            result: blameResultOneOf,
          }),
        }),
      }
    }

    if (family === "report_bug") {
      const reportBugResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReportBugSuccessSchema, {
                output: result,
              }),
            }
          : {
              case: "error" as const,
              value: create(ReportBugErrorSchema, {
                errorMessage: statusMessage || "report_bug failed",
              }),
            }

      return {
        case: "reportBugToolCall" as const,
        value: create(ReportBugToolCallSchema, {
          args: create(ReportBugArgsSchema, {
            title: safeString(args.title),
            file: safeString(
              args.file || args.path || args.filePath || args.file_path
            ),
            startLine:
              this.parseOptionalNonNegativeInt(
                args.startLine ?? args.start_line
              ) ?? 0,
            endLine:
              this.parseOptionalNonNegativeInt(args.endLine ?? args.end_line) ??
              0,
            description: safeString(args.description),
            severity: safeString(args.severity),
            category: safeString(args.category),
            rationale: safeString(args.rationale),
          }),
          result: create(ReportBugResultSchema, {
            result: reportBugResultOneOf,
          }),
        }),
      }
    }

    if (family === "set_active_branch") {
      const setActiveBranchResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(SetActiveBranchSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(SetActiveBranchErrorSchema, {
                error: statusMessage || "set_active_branch failed",
              }),
            }

      return {
        case: "setActiveBranchToolCall" as const,
        value: create(SetActiveBranchToolCallSchema, {
          args: create(SetActiveBranchArgsSchema, {
            path: safeString(args.path),
            branchName: safeString(args.branchName || args.branch_name),
          }),
          result: create(SetActiveBranchResultSchema, {
            result: setActiveBranchResultOneOf,
          }),
        }),
      }
    }

    if (family === "report_bugfix_results") {
      const reportItems = this.normalizeBugfixResultItems(args.results)
      const reportBugfixResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ReportBugfixResultsSuccessSchema, {
                results: reportItems,
              }),
            }
          : {
              case: "error" as const,
              value: create(ReportBugfixResultsErrorSchema, {
                error: statusMessage || "report_bugfix_results failed",
              }),
            }

      return {
        case: "reportBugfixResultsToolCall" as const,
        value: create(ReportBugfixResultsToolCallSchema, {
          args: create(ReportBugfixResultsArgsSchema, {
            summary: safeString(args.summary),
            results: reportItems,
          }),
          result: create(ReportBugfixResultsResultSchema, {
            result: reportBugfixResultOneOf,
          }),
        }),
      }
    }

    if (family === "setup_vm_environment") {
      const setupVmResult =
        status === "success"
          ? {
              result: {
                case: "success" as const,
                value: create(SetupVmEnvironmentSuccessSchema, {}),
              },
            }
          : {}

      return {
        case: "setupVmEnvironmentToolCall" as const,
        value: create(SetupVmEnvironmentToolCallSchema, {
          args: create(SetupVmEnvironmentArgsSchema, {
            installCommand: safeString(
              args.installCommand || args.install_command
            ),
            startCommand: safeString(args.startCommand || args.start_command),
          }),
          // Proto currently defines success-only oneof for this result.
          // Keep oneof unset on failure instead of projecting a false success.
          result: create(SetupVmEnvironmentResultSchema, setupVmResult),
        }),
      }
    }

    if (family === "start_grind_execution") {
      const startGrindExecutionResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(StartGrindExecutionSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(StartGrindExecutionErrorSchema, {
                error: statusMessage || "start_grind_execution failed",
              }),
            }

      return {
        case: "startGrindExecutionToolCall" as const,
        value: create(StartGrindExecutionToolCallSchema, {
          args: create(StartGrindExecutionArgsSchema, {
            explanation: safeString(args.explanation) || undefined,
            toolCallId: callId,
          }),
          result: create(StartGrindExecutionResultSchema, {
            result: startGrindExecutionResultOneOf,
          }),
        }),
      }
    }

    if (family === "start_grind_planning") {
      const startGrindPlanningResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(StartGrindPlanningSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(StartGrindPlanningErrorSchema, {
                error: statusMessage || "start_grind_planning failed",
              }),
            }

      return {
        case: "startGrindPlanningToolCall" as const,
        value: create(StartGrindPlanningToolCallSchema, {
          args: create(StartGrindPlanningArgsSchema, {
            explanation: safeString(args.explanation) || undefined,
            toolCallId: callId,
          }),
          result: create(StartGrindPlanningResultSchema, {
            result: startGrindPlanningResultOneOf,
          }),
        }),
      }
    }

    if (family === "switch_mode") {
      const targetModeId = safeString(args.targetModeId || args.target_mode_id)
      const fromModeId = safeString(
        args.fromModeId ||
          args.from_mode_id ||
          args.currentModeId ||
          args.current_mode_id ||
          targetModeId
      )
      let switchModeResultOneOf: SwitchModeResult["result"]
      if (status === "success") {
        switchModeResultOneOf = {
          case: "success" as const,
          value: create(SwitchModeSuccessSchema, {
            fromModeId,
            toModeId: targetModeId,
          }),
        }
      } else if (status === "rejected") {
        switchModeResultOneOf = {
          case: "rejected" as const,
          value: create(SwitchModeRejectedSchema, {
            reason: statusMessage || "switch_mode rejected",
          }),
        }
      } else {
        switchModeResultOneOf = {
          case: "error" as const,
          value: create(SwitchModeErrorSchema, {
            error: statusMessage || "switch_mode failed",
          }),
        }
      }

      return {
        case: "switchModeToolCall" as const,
        value: create(SwitchModeToolCallSchema, {
          args: create(SwitchModeArgsSchema, {
            targetModeId,
            explanation: safeString(args.explanation) || undefined,
            toolCallId: callId,
          }),
          result: create(SwitchModeResultSchema, {
            result: switchModeResultOneOf,
          }),
        }),
      }
    }

    if (family === "task") {
      const taskSuccessExtra = extraData?.taskSuccess
      const conversationSteps = Array.isArray(
        taskSuccessExtra?.conversationSteps
      )
        ? taskSuccessExtra.conversationSteps
        : Array.isArray(args.conversation_steps)
          ? args.conversation_steps
          : Array.isArray(args.conversationSteps)
            ? args.conversationSteps
            : []
      const isBackground =
        taskSuccessExtra?.isBackground ??
        !!(args.is_background ?? args.isBackground)
      const taskAgentId = safeString(
        taskSuccessExtra?.agentId || args.agentId || args.agent_id
      ).trim()
      const durationMsRaw = taskSuccessExtra?.durationMs
      const durationMs =
        typeof durationMsRaw === "bigint"
          ? durationMsRaw
          : typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
            ? BigInt(Math.max(0, Math.floor(durationMsRaw)))
            : undefined
      const resultSuffix = safeString(taskSuccessExtra?.resultSuffix).trim()
      const transcriptPath = safeString(taskSuccessExtra?.transcriptPath).trim()
      const taskResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(TaskSuccessSchema, {
                conversationSteps: conversationSteps,
                isBackground,
                agentId: taskAgentId || undefined,
                durationMs,
                resultSuffix: resultSuffix || undefined,
                transcriptPath: transcriptPath || undefined,
              }),
            }
          : {
              case: "error" as const,
              value: create(TaskErrorSchema, {
                error: statusMessage || "task failed",
              }),
            }

      return {
        case: "taskToolCall" as const,
        value: create(TaskToolCallSchema, {
          args: this.buildTaskArgs(args),
          result: create(TaskResultSchema, {
            result: taskResultOneOf,
          }),
        }),
      }
    }

    if (family === "computer_use") {
      const actions = Array.isArray(args.actions) ? args.actions : []
      const computerUseResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(ComputerUseSuccessSchema, {
                actionCount: actions.length,
                durationMs: 0,
              }),
            }
          : {
              case: "error" as const,
              value: create(ComputerUseErrorSchema, {
                error: statusMessage || "computer_use failed",
                actionCount: actions.length,
                durationMs: 0,
              }),
            }

      return {
        case: "computerUseToolCall" as const,
        value: create(ComputerUseToolCallSchema, {
          args: create(ComputerUseArgsSchema, {
            toolCallId: callId,
            actions: actions,
          }),
          result: create(ComputerUseResultSchema, {
            result: computerUseResultOneOf,
          }),
        }),
      }
    }

    if (family === "unknown") {
      const fallbackResultOneOf =
        status === "success"
          ? {
              case: "success" as const,
              value: create(TruncatedToolCallSuccessSchema, {}),
            }
          : {
              case: "error" as const,
              value: create(TruncatedToolCallErrorSchema, {
                error:
                  statusMessage ||
                  `${family} completed without dedicated ToolCall result schema`,
              }),
            }

      return {
        case: "truncatedToolCall" as const,
        value: create(TruncatedToolCallSchema, {
          args: create(TruncatedToolCallArgsSchema, {}),
          result: create(TruncatedToolCallResultSchema, {
            result: fallbackResultOneOf,
          }),
        }),
      }
    }

    // Last-resort safety net: always emit protocol-valid result oneof.
    const unhandledFamily = String(family || "unknown")
    const safetyResultOneOf =
      status === "success"
        ? {
            case: "success" as const,
            value: create(TruncatedToolCallSuccessSchema, {}),
          }
        : {
            case: "error" as const,
            value: create(TruncatedToolCallErrorSchema, {
              error:
                statusMessage ||
                `Unhandled tool family "${unhandledFamily}" while building ToolCall result`,
            }),
          }

    return {
      case: "truncatedToolCall" as const,
      value: create(TruncatedToolCallSchema, {
        args: create(TruncatedToolCallArgsSchema, {}),
        result: create(TruncatedToolCallResultSchema, {
          result: safetyResultOneOf,
        }),
      }),
    }
  }

  // ─── Conversation Checkpoint ───────────────────────────────

  /**
   * 创建 ConversationCheckpoint 响应
   */
  createConversationCheckpointResponse(
    conversationId: string,
    model: string,
    checkpoint: {
      pendingToolCalls?: Array<{ id: string; name: string; input: unknown }>
      messageBlobIds?: string[]
      usedTokens?: number
      maxTokens?: number
      workspaceUri?: string
      readPaths?: string[]
      fileStates?: Record<
        string,
        { beforeContent: string; afterContent: string }
      >
      turns?: string[]
      turnTimings?: Array<{ durationMs: number; timestampMs: number }>
      selfSummaryCount?: number
      todos?: Array<{
        id: string
        content: string
        status: string | number
        createdAt: number
        updatedAt: number
        dependencies: string[]
      }>
    }
  ): Buffer {
    // 构建 file_states_v2 (map<string, FileStateStructure>)
    const fileStatesV2: Record<string, any> = {}
    if (checkpoint.fileStates) {
      for (const [path, state] of Object.entries(checkpoint.fileStates)) {
        fileStatesV2[path] = create(FileStateStructureSchema, {
          content: new TextEncoder().encode(state.afterContent || ""),
          initialContent: new TextEncoder().encode(state.beforeContent || ""),
        })
      }
    }

    // 构建 turn_timings (repeated StepTiming)
    const turnTimings = (checkpoint.turnTimings || []).map((t) =>
      create(StepTimingSchema, {
        durationMs: BigInt(t.durationMs || 0),
        timestampMs: BigInt(t.timestampMs || 0),
      })
    )

    // 构建 turns (repeated bytes) — 将 turn ID 编码为 bytes
    const turnsBytes = (checkpoint.turns || []).map((t) =>
      new TextEncoder().encode(t)
    )

    // 构建 ConversationStateStructure 并正确填充字段
    const stateStructure = create(ConversationStateStructureSchema, {
      // Token 统计
      tokenDetails: create(ConversationTokenDetailsSchema, {
        usedTokens: checkpoint.usedTokens || 0,
        maxTokens: checkpoint.maxTokens || 200000,
      }),
      // 待处理工具调用 ID
      pendingToolCalls: (checkpoint.pendingToolCalls || []).map((tc) => tc.id),
      // 已读路径
      readPaths: checkpoint.readPaths || [],
      // 先前工作区 URI
      previousWorkspaceUris: checkpoint.workspaceUri
        ? [checkpoint.workspaceUri]
        : [],
      // Agent 模式
      mode: AgentMode.AGENT,
      // turns (bytes)
      turns: turnsBytes,
      // file_states_v2
      fileStatesV2: fileStatesV2,
      // turn_timings
      turnTimings: turnTimings,
      // self_summary_count
      selfSummaryCount: checkpoint.selfSummaryCount || 0,
      // todos (serialized as bytes[])
      todos: (checkpoint.todos || []).map((todo) => {
        const item = create(TodoItemSchema, {
          id: todo.id,
          content: todo.content,
          status:
            typeof todo.status === "number"
              ? todo.status
              : this.normalizeTodoStatusEnum(todo.status),
          createdAt: BigInt(todo.createdAt || Date.now()),
          updatedAt: BigInt(todo.updatedAt || Date.now()),
          dependencies: todo.dependencies || [],
        })
        return toBinary(TodoItemSchema, item)
      }),
    })

    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "conversationCheckpointUpdate" as const,
        value: stateStructure,
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, msg))
  }

  // ─── KV Server Message ─────────────────────────────────────

  /**
   * 创建 KV Server Message 响应
   */
  createKvServerMessageResponse(kvMessage: KvStorageMessage): Buffer {
    const kvMsg = (() => {
      if (kvMessage.getBlobArgs) {
        return create(KvServerMessageSchema, {
          id: kvMessage.id || 0,
          message: {
            case: "getBlobArgs" as const,
            value: create(GetBlobArgsSchema, {
              blobId: new TextEncoder().encode(
                kvMessage.getBlobArgs.blobId || ""
              ),
            }),
          },
        })
      }
      if (kvMessage.setBlobArgs) {
        return create(KvServerMessageSchema, {
          id: kvMessage.id || 0,
          message: {
            case: "setBlobArgs" as const,
            value: create(SetBlobArgsSchema, {
              blobId: new TextEncoder().encode(
                kvMessage.setBlobArgs.blobId || ""
              ),
              blobData: new TextEncoder().encode(
                kvMessage.setBlobArgs.blobData || ""
              ),
            }),
          },
        })
      }
      return create(KvServerMessageSchema, {
        id: kvMessage.id || 0,
      })
    })()

    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "kvServerMessage" as const,
        value: kvMsg,
      },
    })
    return this.addConnectEnvelope(toBinary(AgentServerMessageSchema, msg))
  }

  // ─── Tool 参数编码辅助方法 ─────────────────────────────────
  // 以下方法保留了旧版的手工编码方式，用于 encodeToolParams
  // 后续可以逐步迁移到 create+toBinary

  /**
   * 编码 tool 参数（用于 ClientSideToolV2Call 的 oneof）
   */
  encodeToolParams(toolName: string, args: Record<string, unknown>): Buffer {
    const normalized = toolName.toLowerCase().replace(/_/g, "")

    try {
      // 使用 ExecServerMessage 的 oneof 结构
      const oneOf = this.buildExecMessageOneOf(normalized, args, "")
      if (oneOf.value) {
        const schema = this.getSchemaForCase(oneOf.case)
        if (schema) {
          return Buffer.from(toBinary(schema as never, oneOf.value as never))
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "unknown encodeToolParams error"
      this.logger.warn(
        `Failed to encode tool params for "${toolName}", falling back to JSON: ${message}`
      )
    }

    // 回退：JSON 编码
    return Buffer.from(JSON.stringify(args), "utf-8")
  }

  createToolParamsField(cursorToolName: string, args: ToolArgs): Buffer {
    return this.encodeToolParams(
      cursorToolName,
      args as Record<string, unknown>
    )
  }

  private getSchemaForCase(caseName: string) {
    const schemaMap = {
      shellArgs: ShellArgsSchema,
      writeArgs: WriteArgsSchema,
      deleteArgs: DeleteArgsSchema,
      grepArgs: GrepArgsSchema,
      readArgs: ReadArgsSchema,
      lsArgs: LsArgsSchema,
      diagnosticsArgs: DiagnosticsArgsSchema,
      mcpArgs: McpArgsSchema,
      backgroundShellSpawnArgs: BackgroundShellSpawnArgsSchema,
      fetchArgs: FetchArgsSchema,
      recordScreenArgs: RecordScreenArgsSchema,
      computerUseArgs: ComputerUseArgsSchema,
      writeShellStdinArgs: WriteShellStdinArgsSchema,
      executeHookArgs: ExecuteHookArgsSchema,
      webSearchArgs: WebSearchArgsSchema,
      webFetchArgs: WebFetchArgsSchema,
      awaitArgs: AwaitArgsSchema,
      aiAttributionArgs: AiAttributionArgsSchema,
      mcpAuthArgs: McpAuthArgsSchema,
      prManagementArgs: PrManagementArgsSchema,
      switchModeArgs: SwitchModeArgsSchema,
      generateImageArgs: GenerateImageArgsSchema,
      listMcpResourcesExecArgs: ListMcpResourcesExecArgsSchema,
      readMcpResourceExecArgs: ReadMcpResourceExecArgsSchema,
      subagentArgs: SubagentArgsSchema,
    }
    return schemaMap[caseName as keyof typeof schemaMap]
  }
}
