/**
 * OpenAI Chat Completions / Completions → Anthropic CreateMessageDto.
 *
 * The bridge's canonical internal representation is the Anthropic Messages
 * shape (CreateMessageDto). This translator maps the inbound OpenAI request
 * onto that IR so the existing MessagesService router can dispatch it to any
 * backend (codex / openai-compat / anthropic / google / kiro) unchanged.
 *
 * Mapping rules:
 *   - system / developer messages    → top-level `system` (concatenated)
 *   - user / assistant messages      → messages[] with content blocks
 *   - assistant tool_calls           → tool_use content blocks
 *   - tool messages                  → tool_result blocks, folded into the
 *                                      preceding/synthesized user turn
 *                                      (Anthropic requires tool_result on a
 *                                      user turn)
 *   - tools (function)               → tools[] with input_schema
 *   - tool_choice                    → Anthropic tool_choice object/string
 *   - max_tokens/max_completion_tokens, temperature, top_p, stop → forwarded
 */

import type { CreateMessageDto } from "../anthropic/dto/create-message.dto"
import type {
  OpenAiChatCompletionRequest,
  OpenAiChatMessage,
  OpenAiCompletionRequest,
  OpenAiContentPart,
  OpenAiFunctionTool,
  OpenAiResponseInputContentPart,
  OpenAiResponsesRequest,
  OpenAiToolChoice,
} from "./openai-types"

// Anthropic content blocks are loosely typed in CreateMessageDto (the DTO
// declares MessageContentDto[] but the wire accepts plain objects). We build
// plain objects matching the Anthropic spec.
type AnthropicBlock = Record<string, unknown>
type AnthropicMessage = {
  role: "user" | "assistant"
  content: AnthropicBlock[]
}

const DEFAULT_MAX_TOKENS = 8192

/**
 * Flatten OpenAI message content (string | parts[]) into Anthropic content
 * blocks. Text parts become text blocks; image_url parts become image blocks.
 */
function translateUserContent(
  content: string | OpenAiContentPart[] | null | undefined
): AnthropicBlock[] {
  if (content == null) return []
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }]
  }

  const blocks: AnthropicBlock[] = []
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text })
    } else if (part.type === "image_url") {
      const url = part.image_url?.url ?? ""
      blocks.push(translateImageUrl(url, part.image_url?.detail))
    }
  }
  return blocks
}

/**
 * Translate an OpenAI image_url into an Anthropic image block. Supports both
 * data URIs (base64) and remote URLs.
 */
function translateImageUrl(url: string, detail?: string): AnthropicBlock {
  const dataUriMatch = /^data:([^;]+);base64,(.*)$/s.exec(url)
  if (dataUriMatch) {
    return {
      type: "image",
      ...(detail ? { detail } : {}),
      source: {
        type: "base64",
        media_type: dataUriMatch[1],
        data: dataUriMatch[2],
      },
    }
  }
  return {
    type: "image",
    ...(detail ? { detail } : {}),
    source: { type: "url", url },
  }
}

/**
 * Extract plain text from OpenAI content for system/developer messages.
 */
function extractSystemText(
  content: string | OpenAiContentPart[] | null | undefined
): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
}

/**
 * Append blocks to the trailing user message, or start a new user message if
 * the last emitted message was not a user turn. Used to fold OpenAI `tool`
 * messages (and any following content) into a single Anthropic user turn.
 */
function appendToUserTurn(
  messages: AnthropicMessage[],
  blocks: AnthropicBlock[]
): void {
  if (blocks.length === 0) return
  const last = messages[messages.length - 1]
  if (last && last.role === "user") {
    last.content.push(...blocks)
  } else {
    messages.push({ role: "user", content: blocks })
  }
}

function translateToolCalls(message: OpenAiChatMessage): AnthropicBlock[] {
  if (!message.tool_calls || message.tool_calls.length === 0) return []
  return message.tool_calls.map((call) => {
    let input: Record<string, unknown> = {}
    const raw = call.function?.arguments
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === "object") {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // Malformed arguments — preserve raw string so the backend can see it
        input = { _raw_arguments: raw }
      }
    }
    return {
      type: "tool_use",
      id: call.id,
      name: call.function?.name ?? "",
      input,
    }
  })
}

function translateTools(
  tools: OpenAiFunctionTool[] | undefined
): CreateMessageDto["tools"] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters ?? {
        type: "object",
        properties: {},
      },
    })) as CreateMessageDto["tools"]
}

function translateToolChoice(
  toolChoice: OpenAiToolChoice | undefined
): CreateMessageDto["tool_choice"] | undefined {
  if (toolChoice == null) return undefined
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "none":
        return { type: "none" }
      case "auto":
        return { type: "auto" }
      case "required":
        return { type: "any" }
      default:
        return undefined
    }
  }
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name }
  }
  return undefined
}

function normalizeStop(
  stop: string | string[] | undefined
): string[] | undefined {
  if (stop == null) return undefined
  const list = Array.isArray(stop) ? stop : [stop]
  const filtered = list.filter((s) => typeof s === "string" && s.length > 0)
  return filtered.length > 0 ? filtered : undefined
}

/**
 * Translate an OpenAI Chat Completions request into the bridge's canonical
 * Anthropic CreateMessageDto.
 */
export function translateOpenAiChatToCreateMessage(
  req: OpenAiChatCompletionRequest
): CreateMessageDto {
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []

  for (const message of req.messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = extractSystemText(message.content)
        if (text) systemParts.push(text)
        break
      }
      case "user": {
        const blocks = translateUserContent(message.content)
        appendToUserTurn(messages, blocks)
        break
      }
      case "assistant": {
        const blocks: AnthropicBlock[] = []
        const text =
          typeof message.content === "string"
            ? message.content
            : extractSystemText(message.content)
        if (text) blocks.push({ type: "text", text })
        blocks.push(...translateToolCalls(message))
        // An assistant turn may legitimately be empty if it only carried
        // tool_calls that produced no text; still emit the tool_use blocks.
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks })
        }
        break
      }
      case "tool": {
        // OpenAI tool result → Anthropic tool_result block on a user turn.
        const block: AnthropicBlock = {
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: translateToolResultContent(message.content),
        }
        appendToUserTurn(messages, [block])
        break
      }
    }
  }

  const dto: CreateMessageDto = {
    model: req.model,
    messages: messages as unknown as CreateMessageDto["messages"],
    max_tokens:
      req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream: req.stream ?? false,
  }

  if (systemParts.length > 0) dto.system = systemParts.join("\n\n")

  const tools = translateTools(req.tools)
  if (tools) dto.tools = tools

  const toolChoice = translateToolChoice(req.tool_choice)
  if (toolChoice) dto.tool_choice = toolChoice

  if (typeof req.temperature === "number") dto.temperature = req.temperature
  if (typeof req.top_p === "number") dto.top_p = req.top_p

  const stop = normalizeStop(req.stop)
  if (stop) dto.stop_sequences = stop

  // reasoning_effort → Anthropic-style thinking hint via output_config.effort,
  // which the backends already understand for GPT/Claude reasoning models.
  if (typeof req.reasoning_effort === "string" && req.reasoning_effort) {
    // The canonical adapter reads output_config only when thinking is enabled.
    // Merely copying effort silently dropped xhigh and used the model default.
    dto.thinking =
      req.reasoning_effort === "none"
        ? { type: "disabled" }
        : { type: "adaptive" }
    if (req.reasoning_effort !== "none")
      dto.output_config = { effort: req.reasoning_effort }
  }

  // service_tier ("fast", "priority", ...) is carried as-is; the backend
  // decides what it means (Codex reads "fast" as its priority tier).
  if (typeof req.service_tier === "string" && req.service_tier) {
    dto.service_tier = req.service_tier
  }

  return dto
}

function translateResponseContent(
  content: string | OpenAiResponseInputContentPart[]
): string | OpenAiContentPart[] {
  if (typeof content === "string") return content

  const parts: OpenAiContentPart[] = []
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      parts.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "input_image" && part.image_url) {
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url,
          ...(part.detail ? { detail: part.detail } : {}),
        },
      })
    }
  }
  return parts
}

export function translateOpenAiResponseToCreateMessage(
  req: OpenAiResponsesRequest
): CreateMessageDto {
  const messages: OpenAiChatMessage[] = []
  if (req.instructions?.trim()) {
    messages.push({ role: "system", content: req.instructions })
  }

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input })
  } else {
    for (const item of req.input) {
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id || item.id || "",
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        })
        continue
      }
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: item.output,
        })
        continue
      }
      messages.push({
        role: item.role,
        content: translateResponseContent(item.content),
      })
    }
  }

  const tools: OpenAiFunctionTool[] | undefined = req.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const toolChoice: OpenAiToolChoice | undefined =
    typeof req.tool_choice === "object"
      ? {
          type: "function",
          function: { name: req.tool_choice.name },
        }
      : req.tool_choice

  return translateOpenAiChatToCreateMessage({
    model: req.model,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: req.stream,
    max_completion_tokens: req.max_output_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    reasoning_effort: req.reasoning?.effort,
    service_tier: req.service_tier,
  })
}

/**
 * Anthropic tool_result `content` accepts a string or an array of content
 * blocks. OpenAI tool message content is a string (or text parts), so we
 * normalize to a plain string when possible.
 */
function translateToolResultContent(
  content: string | OpenAiContentPart[] | null | undefined
): string | AnthropicBlock[] {
  if (content == null) return ""
  if (typeof content === "string") return content
  // Mixed parts (rare for tool messages) → preserve as text blocks.
  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => ({ type: "text", text: part.text }))
}

/**
 * Translate a legacy Completions request into the canonical
 * CreateMessageDto by wrapping the prompt as a single user message.
 */
export function translateOpenAiCompletionToCreateMessage(
  req: OpenAiCompletionRequest
): CreateMessageDto {
  const prompt = Array.isArray(req.prompt) ? req.prompt.join("\n") : req.prompt
  const dto: CreateMessageDto = {
    model: req.model,
    messages: [
      { role: "user", content: prompt },
    ] as unknown as CreateMessageDto["messages"],
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream: req.stream ?? false,
  }
  if (typeof req.temperature === "number") dto.temperature = req.temperature
  if (typeof req.top_p === "number") dto.top_p = req.top_p
  const stop = normalizeStop(req.stop)
  if (stop) dto.stop_sequences = stop
  return dto
}
