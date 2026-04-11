/**
 * Codex Request Translator
 *
 * Translates Claude/Anthropic Messages API requests into OpenAI Responses API
 * format for forwarding to the Codex upstream.
 *
 * Ported from CLIProxyAPI: internal/translator/codex/claude/codex_claude_request.go
 */

import { normalizeToolProtocolMessages } from "../../context/tool-protocol-normalizer"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import { sanitizeResponsesToolCallIntegrity } from "../shared/openai-tool-call-integrity"
import { resolveCodexReasoningEffort } from "./codex-thinking"
import { buildShortNameMap, shortenNameIfNeeded } from "./tool-name-shortener"

// ── Types for Codex Responses API ──────────────────────────────────────

interface CodexInputMessage {
  type: "message"
  role: string
  content: Array<Record<string, unknown>>
}

interface CodexFunctionCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

interface CodexFunctionCallOutput {
  type: "function_call_output"
  call_id: string
  output: string | Array<Record<string, unknown>>
}

type CodexInputItem =
  | CodexInputMessage
  | CodexFunctionCall
  | CodexFunctionCallOutput

interface CodexTool {
  type: "function" | "web_search"
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

interface CodexRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexTool[]
  tool_choice?: string | Record<string, unknown>
  stream: boolean
  store: boolean
  parallel_tool_calls: boolean
  reasoning: { effort: string; summary: string }
  include: string[]
  [key: string]: unknown
}

function resolveParallelToolCalls(toolChoice: unknown): boolean {
  if (!toolChoice || typeof toolChoice !== "object") {
    return true
  }

  const disableParallelToolUse = (
    toolChoice as { disable_parallel_tool_use?: unknown }
  ).disable_parallel_tool_use

  if (typeof disableParallelToolUse !== "boolean") {
    return true
  }

  return !disableParallelToolUse
}

function normalizeCodexServiceTier(
  serviceTier?: string
): "priority" | undefined {
  const normalized = serviceTier?.trim().toLowerCase()
  return normalized === "priority" ? "priority" : undefined
}

// ── Tool parameter normalization ───────────────────────────────────────

function normalizeToolParameters(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} }
  }
  const result = { ...schema }
  if (!result.type) {
    result.type = "object"
  }
  if (result.type === "object" && !result.properties) {
    result.properties = {}
  }
  // Remove $schema field
  delete result.$schema
  return result
}

// ── Main translator ────────────────────────────────────────────────────

/**
 * Translate a Claude/Anthropic CreateMessageDto into a Codex Responses API request body.
 *
 * This performs the following transformations:
 * 1. system → input[{type:"message", role:"developer", content:[{type:"input_text"}]}]
 * 2. messages → input items (message / function_call / function_call_output)
 * 3. tools → Codex function tools with shortened names
 * 4. thinking/output_config → reasoning.effort
 * 5. Forces: stream=true, store=false
 */
export function translateClaudeToCodex(
  dto: CreateMessageDto,
  modelName: string
): CodexRequest {
  let input: CodexInputItem[] = []

  // ── Build tool name shortening map ───────────────────────────────
  const toolNames: string[] = []
  if (dto.tools) {
    for (const tool of dto.tools) {
      if (tool.name) {
        toolNames.push(tool.name)
      }
    }
  }
  const shortMap =
    toolNames.length > 0
      ? buildShortNameMap(toolNames)
      : new Map<string, string>()

  const shortenName = (name: string): string => {
    const short = shortMap.get(name)
    if (short) return short
    return shortenNameIfNeeded(name)
  }

  // ── Process system prompt → developer message ────────────────────
  if (dto.system) {
    const devMessage: CodexInputMessage = {
      type: "message",
      role: "developer",
      content: [],
    }

    if (typeof dto.system === "string") {
      if (dto.system.trim()) {
        devMessage.content.push({ type: "input_text", text: dto.system })
      }
    } else if (Array.isArray(dto.system)) {
      for (const block of dto.system) {
        if (block.type === "text" && block.text) {
          // Skip billing headers
          if (block.text.startsWith("x-anthropic-billing-header: ")) {
            continue
          }
          devMessage.content.push({ type: "input_text", text: block.text })
        }
      }
    }

    if (devMessage.content.length > 0) {
      input.push(devMessage)
    }
  }

  // ── Normalize messages: remove orphaned tool_result blocks ────
  const protocolNormalized = normalizeToolProtocolMessages(
    dto.messages as Array<{ role: "user" | "assistant"; content: unknown }>,
    { pendingToolUseIds: dto._pendingToolUseIds }
  )
  const normalizedMessages = protocolNormalized.messages

  // ── Process messages ─────────────────────────────────────────────
  for (const msg of normalizedMessages) {
    const role = msg.role

    // Build content blocks for the current message
    const messageContent: Array<Record<string, unknown>> = []
    let hasContent = false

    const flushMessage = () => {
      if (hasContent) {
        input.push({
          type: "message",
          role,
          content: [...messageContent],
        })
        messageContent.length = 0
        hasContent = false
      }
    }

    const appendTextContent = (text: string) => {
      const partType = role === "assistant" ? "output_text" : "input_text"
      messageContent.push({ type: partType, text })
      hasContent = true
    }

    const appendImageContent = (dataURL: string) => {
      messageContent.push({ type: "input_image", image_url: dataURL })
      hasContent = true
    }

    if (typeof msg.content === "string") {
      if (msg.content) {
        appendTextContent(msg.content)
      }
      flushMessage()
    } else if (Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{
        type?: string
        text?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?:
          | string
          | Array<{
              type: string
              text?: string
              source?: Record<string, unknown>
            }>
        source?: {
          data?: string
          base64?: string
          media_type?: string
          mime_type?: string
        }
      }>
      for (const block of blocks) {
        const contentType = block.type

        switch (contentType) {
          case "text":
            if (block.text) {
              appendTextContent(block.text)
            }
            break

          case "image": {
            const source = block.source
            if (source) {
              const data = source.data || source.base64
              if (data) {
                const mediaType =
                  source.media_type ||
                  source.mime_type ||
                  "application/octet-stream"
                appendImageContent(`data:${mediaType};base64,${data}`)
              }
            }
            break
          }

          case "tool_use": {
            // Flush any pending text content first
            flushMessage()

            const funcCall: CodexFunctionCall = {
              type: "function_call",
              call_id: block.id || "",
              name: shortenName(block.name || ""),
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input || {}),
            }
            input.push(funcCall)
            break
          }

          case "tool_result": {
            // Flush any pending text content first
            flushMessage()

            let output: string | Array<Record<string, unknown>> = ""
            const toolContent = block.content

            if (typeof toolContent === "string") {
              output = toolContent
            } else if (Array.isArray(toolContent)) {
              const parts: Array<Record<string, unknown>> = []
              for (const part of toolContent) {
                if (part.type === "text" && part.text) {
                  parts.push({ type: "input_text", text: part.text })
                } else if (part.type === "image" && part.source) {
                  const src = part.source as {
                    data?: string
                    base64?: string
                    media_type?: string
                    mime_type?: string
                  }
                  const imgData = src.data || src.base64
                  if (imgData) {
                    const mediaType =
                      src.media_type ||
                      src.mime_type ||
                      "application/octet-stream"
                    parts.push({
                      type: "input_image",
                      image_url: `data:${mediaType};base64,${imgData}`,
                    })
                  }
                }
              }
              output = parts.length > 0 ? parts : ""
            }

            const funcOutput: CodexFunctionCallOutput = {
              type: "function_call_output",
              call_id: block.tool_use_id || "",
              output,
            }
            input.push(funcOutput)
            break
          }

          default:
            // Unknown content type, try to extract text
            if (block.text) {
              appendTextContent(block.text)
            }
            break
        }
      }
      flushMessage()
    }
  }

  const sanitizedInput = sanitizeResponsesToolCallIntegrity(
    input,
    dto._pendingToolUseIds
  )
  input = sanitizedInput.items

  // ── Convert tools ────────────────────────────────────────────────
  let codexTools: CodexTool[] | undefined
  if (dto.tools && dto.tools.length > 0) {
    codexTools = []
    for (const tool of dto.tools) {
      // Special handling: Claude web search tool → Codex web_search
      if (tool.type === "web_search_20250305") {
        codexTools.push({ type: "web_search" })
        continue
      }

      const codexTool: CodexTool = {
        type: "function",
        name: shortenName(tool.name || ""),
        description: tool.description,
        parameters: normalizeToolParameters(tool.input_schema),
        strict: false,
      }
      codexTools.push(codexTool)
    }
  }

  // ── Convert thinking → reasoning.effort ──────────────────────────
  const reasoningEffort = resolveCodexReasoningEffort(dto, modelName)
  const parallelToolCalls = resolveParallelToolCalls(dto.tool_choice)

  // ── Build final request ──────────────────────────────────────────
  const request: CodexRequest = {
    model: modelName,
    instructions: "",
    input,
    stream: true,
    store: false,
    parallel_tool_calls: parallelToolCalls,
    reasoning: {
      effort: reasoningEffort,
      summary: "auto",
    },
    include: ["reasoning.encrypted_content"],
  }

  const serviceTier = normalizeCodexServiceTier(dto.service_tier)
  if (serviceTier) {
    request.service_tier = serviceTier
  }

  if (codexTools && codexTools.length > 0) {
    request.tools = codexTools
    request.tool_choice = "auto"
  }

  return request
}
