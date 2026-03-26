/**
 * OpenAI-Compatible Backend Service
 *
 * Translates Claude/Anthropic Messages API requests into standard OpenAI
 * Chat Completions API format for forwarding to third-party providers
 * (e.g. one-api, new-api, or any OpenAI-compatible endpoint).
 *
 * Unlike CodexService which targets chatgpt.com's proprietary Responses API,
 * this service uses the standard /chat/completions endpoint with simple
 * Bearer token authentication.
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"

// ── Types for OpenAI Chat Completions API ──────────────────────────────

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>
  name?: string
  tool_calls?: ChatCompletionToolCall[]
  tool_call_id?: string
}

interface ChatCompletionToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

interface ChatCompletionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface ChatCompletionRequest {
  model: string
  messages: ChatCompletionMessage[]
  tools?: ChatCompletionTool[]
  tool_choice?: string | Record<string, unknown>
  stream: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort: string }
  reasoning_effort?: string
  [key: string]: unknown
}

function supportsOpenAiCompatReasoning(modelName: string): boolean {
  const normalized = modelName.toLowerCase().trim()
  return (
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("codex")
  )
}

function normalizeOpenAiCompatReasoningEffort(effort: string): string {
  const normalized = effort.toLowerCase().trim()

  switch (normalized) {
    case "none":
    case "minimal":
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
    case "xhigh":
    case "max":
    case "auto":
      return "high"
    default:
      return "medium"
  }
}

function resolveOpenAiCompatReasoningEffort(dto: CreateMessageDto): string {
  if (!dto.thinking) {
    return "medium"
  }

  switch (dto.thinking.type) {
    case "enabled": {
      const budget = dto.thinking.budget_tokens
      if (budget == null) return "medium"
      if (budget <= 0) return "low"
      if (budget <= 1024) return "low"
      if (budget <= 8192) return "medium"
      return "high"
    }
    case "disabled":
      return "low"
    case "adaptive":
    case "auto":
      return normalizeOpenAiCompatReasoningEffort(
        typeof dto.output_config?.effort === "string"
          ? dto.output_config.effort
          : "high"
      )
    default:
      return "medium"
  }
}

// ── Streaming state ────────────────────────────────────────────────────

interface StreamState {
  blockIndex: number
  hasToolCall: boolean
  activeToolCalls: Map<number, { id: string; name: string; arguments: string }>
  responseId: string
  model: string
  messageStartEmitted: boolean
  thinkingBlockActive: boolean
}

function createStreamState(): StreamState {
  return {
    blockIndex: 0,
    hasToolCall: false,
    activeToolCalls: new Map(),
    responseId: "",
    model: "",
    messageStartEmitted: false,
    thinkingBlockActive: false,
  }
}

// ── SSE helpers ────────────────────────────────────────────────────────

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class OpenaiCompatService implements OnModuleInit {
  private readonly logger = new Logger(OpenaiCompatService.name)

  private apiKey = ""
  private baseUrl = ""
  private proxyUrl = ""

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.apiKey = this.configService
      .get<string>("OPENAI_COMPAT_API_KEY", "")
      .trim()
    this.baseUrl = this.configService
      .get<string>("OPENAI_COMPAT_BASE_URL", "")
      .trim()
    this.proxyUrl = this.configService
      .get<string>("OPENAI_COMPAT_PROXY_URL", "")
      .trim()

    const hasCredentials = !!(this.apiKey && this.baseUrl)
    this.logger.log(
      `OpenAI-compatible backend initialized: baseUrl=${this.baseUrl || "(none)"}, ` +
        `hasApiKey=${!!this.apiKey}, hasProxy=${!!this.proxyUrl}`
    )
    if (!hasCredentials) {
      this.logger.log(
        "No OpenAI-compatible credentials configured. " +
          "Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY to enable."
      )
    }
  }

  /**
   * Check if the backend is available (has credentials configured).
   */
  isAvailable(): boolean {
    return !!(this.apiKey && this.baseUrl)
  }

  /**
   * Check if the backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  // ── Proxy agent ──────────────────────────────────────────────────────

  private buildProxyAgent():
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    if (!this.proxyUrl) return undefined

    try {
      const url = new URL(this.proxyUrl)
      switch (url.protocol) {
        case "http:":
          return new HttpProxyAgent(this.proxyUrl)
        case "https:":
          return new HttpsProxyAgent(this.proxyUrl)
        case "socks5:":
        case "socks5h:":
        case "socks4:":
          return new SocksProxyAgent(this.proxyUrl)
        default:
          this.logger.error(`Unsupported proxy scheme: ${url.protocol}`)
          return undefined
      }
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  // ── Request translation ──────────────────────────────────────────────

  /**
   * Translate Claude/Anthropic DTO → OpenAI Chat Completions request body.
   */
  private translateRequest(
    dto: CreateMessageDto,
    stream: boolean
  ): ChatCompletionRequest {
    const messages: ChatCompletionMessage[] = []

    // System prompt
    if (dto.system) {
      let systemText: string
      if (typeof dto.system === "string") {
        systemText = dto.system
      } else if (Array.isArray(dto.system)) {
        systemText = dto.system
          .filter(
            (block): block is { type: string; text: string } =>
              typeof block === "object" &&
              block !== null &&
              block.type === "text"
          )
          .map((block) => block.text)
          .join("\n")
      } else {
        systemText = ""
      }
      if (systemText.trim()) {
        messages.push({ role: "system", content: systemText })
      }
    }

    // Messages
    for (const msg of dto.messages) {
      const role = msg.role as "user" | "assistant"

      if (typeof msg.content === "string") {
        messages.push({ role, content: msg.content })
        continue
      }

      if (!Array.isArray(msg.content)) {
        messages.push({ role, content: "" })
        continue
      }

      const blocks = msg.content as Array<{
        type?: string
        text?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?: string | Array<{ type: string; text?: string }>
        source?: {
          data?: string
          base64?: string
          media_type?: string
          mime_type?: string
        }
      }>

      // Separate text/image, tool_use, and tool_result blocks
      const textParts: string[] = []
      const toolCalls: ChatCompletionToolCall[] = []
      const toolResults: ChatCompletionMessage[] = []

      for (const block of blocks) {
        switch (block.type) {
          case "text":
            if (block.text) textParts.push(block.text)
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
                // For image content, we'll include it as text description
                // since not all OpenAI-compatible APIs support vision
                textParts.push(`[Image: ${mediaType}]`)
              }
            }
            break
          }

          case "tool_use":
            toolCalls.push({
              id: block.id || `call_${crypto.randomUUID()}`,
              type: "function",
              function: {
                name: block.name || "",
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              },
            })
            break

          case "tool_result": {
            let resultContent = ""
            if (typeof block.content === "string") {
              resultContent = block.content
            } else if (Array.isArray(block.content)) {
              resultContent = block.content
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text)
                .join("\n")
            }
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id || "",
              content: resultContent,
            })
            break
          }

          default:
            if (block.text) textParts.push(block.text)
            break
        }
      }

      // Emit assistant message with tool_calls (if any)
      if (role === "assistant" && toolCalls.length > 0) {
        const assistantMsg: ChatCompletionMessage = {
          role: "assistant",
          tool_calls: toolCalls,
        }
        if (textParts.length > 0) {
          assistantMsg.content = textParts.join("\n")
        }
        messages.push(assistantMsg)
      } else if (textParts.length > 0) {
        messages.push({ role, content: textParts.join("\n") })
      } else if (role === "assistant") {
        // Empty assistant message (no text, no tool calls)
        messages.push({ role, content: "" })
      }

      // Emit tool results as separate messages
      for (const toolResult of toolResults) {
        messages.push(toolResult)
      }
    }

    // ── Integrity check: strip orphan tool_calls ─────────────────────
    // Context truncation may drop tool_result messages while keeping the
    // corresponding assistant tool_calls block. OpenAI API requires every
    // tool_call to have a matching tool response. Strip orphan tool_calls
    // and orphan tool responses to prevent 400 errors.
    this.sanitizeToolCallIntegrity(messages)

    // Build request
    const request: ChatCompletionRequest = {
      model: dto.model,
      messages,
      stream,
    }

    if (supportsOpenAiCompatReasoning(dto.model)) {
      const effort = resolveOpenAiCompatReasoningEffort(dto)
      request.reasoning = { effort }
      request.reasoning_effort = effort
    }

    if (dto.max_tokens) {
      request.max_tokens = dto.max_tokens
    }
    if (dto.temperature != null) {
      request.temperature = dto.temperature
    }
    if (dto.top_p != null) {
      request.top_p = dto.top_p
    }

    // Stream options for usage in streaming mode
    if (stream) {
      request.stream_options = { include_usage: true }
    }

    // Tools
    if (dto.tools && dto.tools.length > 0) {
      const tools: ChatCompletionTool[] = []
      for (const tool of dto.tools) {
        if (tool.type === "web_search_20250305") continue
        tools.push({
          type: "function",
          function: {
            name: tool.name || "",
            description: tool.description,
            parameters: tool.input_schema || { type: "object", properties: {} },
          },
        })
      }
      if (tools.length > 0) {
        request.tools = tools
        request.tool_choice = "auto"
      }
    }

    return request
  }

  // ── Tool call integrity sanitizer ─────────────────────────────────

  /**
   * Ensure every assistant tool_call has a matching tool response and
   * every tool response has a matching tool_call. Strip any orphans.
   * Mutates the array in-place.
   */
  private sanitizeToolCallIntegrity(messages: ChatCompletionMessage[]): void {
    // Collect all tool response IDs
    const toolResponseIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResponseIds.add(msg.tool_call_id)
      }
    }

    // Collect all tool_call IDs
    const toolCallIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIds.add(tc.id)
        }
      }
    }

    // Strip orphan tool_calls from assistant messages (no matching tool response)
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.tool_calls) continue

      const before = msg.tool_calls.length
      msg.tool_calls = msg.tool_calls.filter((tc) => toolResponseIds.has(tc.id))

      if (msg.tool_calls.length < before) {
        this.logger.warn(
          `[sanitize] Stripped ${before - msg.tool_calls.length} orphan tool_call(s) from assistant message`
        )
      }
      if (msg.tool_calls.length === 0) {
        delete msg.tool_calls
      }
    }

    // Strip orphan tool responses (no matching tool_call)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg && msg.role === "tool" && msg.tool_call_id) {
        if (!toolCallIds.has(msg.tool_call_id)) {
          this.logger.warn(
            `[sanitize] Stripped orphan tool response: ${msg.tool_call_id}`
          )
          messages.splice(i, 1)
        }
      }
    }

    // Remove empty assistant messages (had only tool_calls, all stripped)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (
        msg &&
        msg.role === "assistant" &&
        !msg.tool_calls &&
        (!msg.content || msg.content === "")
      ) {
        messages.splice(i, 1)
      }
    }
  }

  // ── Simple streaming completion (no Anthropic translation) ──────────

  /**
   * Stream a simple chat completion request directly, yielding text deltas.
   * Used for non-chat features like diff review that don't need Anthropic translation.
   */
  async *streamSimpleCompletion(
    model: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: { temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string> {
    if (!this.isAvailable()) {
      throw new Error("OpenAI-compatible backend not configured")
    }

    const url = this.buildUrl()
    const headers = this.buildHeaders(true)
    const body: ChatCompletionRequest = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options?.temperature != null) body.temperature = options.temperature
    if (options?.max_tokens != null) body.max_tokens = options.max_tokens

    const fetchOptions: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
    const agent = this.buildProxyAgent()
    if (agent) {
      ;(fetchOptions as Record<string, unknown>).agent = agent
    }

    this.logger.log(
      `[SimpleCompletion] Streaming request to ${url} (model=${model})`
    )

    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorBody}`
      )
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error("No response body reader")

    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data: ")) continue
          const data = trimmed.slice(6)
          if (data === "[DONE]") return

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const content = parsed.choices?.[0]?.delta?.content
            if (content) yield content
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ── URL builder ──────────────────────────────────────────────────────

  private buildUrl(): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`
  }

  // ── Headers ──────────────────────────────────────────────────────────

  private buildHeaders(stream: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
    }
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through the OpenAI-compatible backend.
   */
  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        "OpenAI-compatible backend not configured: missing API key or base URL"
      )
    }

    const request = this.translateRequest(dto, false)
    const url = this.buildUrl()
    const headers = this.buildHeaders(false)

    this.logger.log(
      `[OpenAI-Compat] Non-stream request: model=${request.model}, url=${url}, reasoning=${JSON.stringify(request.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(300_000),
    }

    const agent = this.buildProxyAgent()
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorBody.slice(0, 200)}`
      )
    }

    const result = (await response.json()) as Record<string, unknown>
    return this.translateNonStreamResponse(result)
  }

  /**
   * Translate OpenAI Chat Completion response → Anthropic response.
   */
  private translateNonStreamResponse(
    completion: Record<string, unknown>
  ): AnthropicResponse {
    const choices = completion.choices as Array<Record<string, unknown>>
    const choice = choices?.[0]
    const message = choice?.message as Record<string, unknown>
    const content: ContentBlock[] = []
    let hasToolCall = false

    // Text content
    const text = message?.content as string
    if (text) {
      content.push({ type: "text", text })
    }

    // Tool calls
    const toolCalls = message?.tool_calls as Array<Record<string, unknown>>
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        hasToolCall = true
        const func = tc.function as Record<string, unknown>
        let input: Record<string, unknown> = {}
        const argsStr = func?.arguments as string
        if (argsStr) {
          try {
            input = JSON.parse(argsStr) as Record<string, unknown>
          } catch {
            // Leave input empty
          }
        }
        content.push({
          type: "tool_use",
          id: (tc.id as string) || `call_${crypto.randomUUID()}`,
          name: (func?.name as string) || "",
          input,
        })
      }
    }

    // Usage
    const usage = completion.usage as Record<string, unknown>
    const inputTokens = (usage?.prompt_tokens as number) || 0
    const outputTokens = (usage?.completion_tokens as number) || 0

    // Stop reason
    const finishReason = choice?.finish_reason as string
    let stopReason: string
    if (hasToolCall) {
      stopReason = "tool_use"
    } else if (finishReason === "length") {
      stopReason = "max_tokens"
    } else {
      stopReason = "end_turn"
    }

    return {
      id: (completion.id as string) || `chatcmpl-${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: (completion.model as string) || "",
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through the OpenAI-compatible backend.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendClaudeMessageStream(
    dto: CreateMessageDto
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isAvailable()) {
      throw new Error(
        "OpenAI-compatible backend not configured: missing API key or base URL"
      )
    }

    const request = this.translateRequest(dto, true)
    const url = this.buildUrl()
    const headers = this.buildHeaders(true)

    this.logger.log(
      `[OpenAI-Compat] Stream request: model=${request.model}, url=${url}, reasoning=${JSON.stringify(request.reasoning || null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(600_000),
    }

    const agent = this.buildProxyAgent()
    if (agent) {
      fetchOptions.dispatcher = agent
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[OpenAI-Compat] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )
      throw new Error(
        `OpenAI-compatible API error ${response.status}: ${errorBody.slice(0, 200)}`
      )
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible response has no body")
    }

    // Stream SSE events
    const state = createStreamState()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const events = this.translateStreamChunk(trimmed, state)
          for (const event of events) {
            yield event
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const events = this.translateStreamChunk(buffer.trim(), state)
        for (const event of events) {
          yield event
        }
      }

      // Emit final message_delta + message_stop if not already emitted
      if (state.messageStartEmitted) {
        yield* this.emitStreamEnd(state)
      }
    } finally {
      reader.releaseLock()
    }

    this.logger.log(
      `[OpenAI-Compat] Stream completed: model=${state.model}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
  }

  /**
   * Translate a single OpenAI SSE chunk line → Claude SSE event(s).
   *
   * OpenAI stream format:
   *   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}
   *   data: [DONE]
   */
  private previewReasoningValue(value: unknown): string {
    if (typeof value === "string") {
      return value.slice(0, 200)
    }

    try {
      return JSON.stringify(value).slice(0, 200)
    } catch {
      return String(value).slice(0, 200)
    }
  }

  private logReasoningHit(source: string, value: unknown): void {
    this.logger.debug(
      `[OpenAI-Compat] Reasoning chunk detected: source=${source}, type=${typeof value}, preview=${this.previewReasoningValue(value)}`
    )
  }

  private emitThinkingDelta(
    state: StreamState,
    thinkingText: string
  ): string[] {
    if (!thinkingText) return []

    const results: string[] = []
    if (!state.thinkingBlockActive) {
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "thinking", thinking: "" },
        })
      )
      state.thinkingBlockActive = true
    }

    results.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "thinking_delta", thinking: thinkingText },
      })
    )

    return results
  }

  private closeThinkingBlock(state: StreamState): string[] {
    if (!state.thinkingBlockActive) return []

    state.thinkingBlockActive = false
    const results = [
      formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.blockIndex,
      }),
    ]
    state.blockIndex++
    return results
  }

  private translateStreamChunk(line: string, state: StreamState): string[] {
    if (!line.startsWith("data:")) return []

    const jsonStr = line.slice(5).trim()
    if (!jsonStr || jsonStr === "[DONE]") return []

    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      return []
    }

    const results: string[] = []

    // Capture response metadata
    if (!state.responseId && chunk.id) {
      state.responseId = chunk.id as string
    }
    if (!state.model && chunk.model) {
      state.model = chunk.model as string
    }

    // Emit message_start on first chunk
    if (!state.messageStartEmitted) {
      state.messageStartEmitted = true
      results.push(
        formatSseEvent("message_start", {
          type: "message_start",
          message: {
            id: state.responseId || `chatcmpl-${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: state.model || "",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [],
            stop_reason: null,
          },
        })
      )
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined
    if (!choices || choices.length === 0) return results

    const choice = choices[0]
    if (!choice) return results
    const delta = choice.delta as Record<string, unknown>
    if (!delta) return results

    const finishReason = choice.finish_reason as string | null

    const closeThinkingBeforeContent = () => {
      if (state.thinkingBlockActive) {
        results.push(...this.closeThinkingBlock(state))
      }
    }

    // Handle provider-specific reasoning/thinking deltas
    const deltaReasoning = delta.reasoning as string | undefined
    const deltaReasoningContent = delta.reasoning_content as string | undefined
    const deltaReasoningText =
      deltaReasoning || deltaReasoningContent || delta.reasoning_text

    if (typeof deltaReasoningText === "string" && deltaReasoningText) {
      const source = deltaReasoning
        ? "delta.reasoning"
        : deltaReasoningContent
          ? "delta.reasoning_content"
          : "delta.reasoning_text"
      this.logReasoningHit(source, deltaReasoningText)
      results.push(...this.emitThinkingDelta(state, deltaReasoningText))
    }

    const providerMessage = chunk.message
    const providerReasoning =
      providerMessage && typeof providerMessage === "object"
        ? (providerMessage as Record<string, unknown>).reasoning
        : undefined
    if (typeof providerReasoning === "string" && providerReasoning) {
      this.logReasoningHit("message.reasoning", providerReasoning)
      results.push(...this.emitThinkingDelta(state, providerReasoning))
    } else if (
      providerReasoning &&
      typeof providerReasoning === "object" &&
      typeof (providerReasoning as Record<string, unknown>).content === "string"
    ) {
      results.push(
        ...this.emitThinkingDelta(
          state,
          (providerReasoning as Record<string, unknown>).content as string
        )
      )
    }

    // Handle text content delta
    const contentDelta = delta.content as string | null
    if (contentDelta != null && contentDelta !== "") {
      closeThinkingBeforeContent()
      // Start a new text block if this is the first text content
      if (
        state.blockIndex === 0 ||
        // Need to start a new text block after tool blocks
        (state.hasToolCall && state.activeToolCalls.size === 0)
      ) {
        results.push(
          formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: { type: "text", text: "" },
          })
        )
      }

      results.push(
        formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "text_delta", text: contentDelta },
        })
      )
    }

    // Handle tool call deltas
    const toolCallDeltas = delta.tool_calls as Array<
      Record<string, unknown>
    > | null
    if (Array.isArray(toolCallDeltas)) {
      for (const tc of toolCallDeltas) {
        const tcIndex = (tc.index as number) ?? 0
        const func = tc.function as Record<string, unknown> | undefined

        if (!state.activeToolCalls.has(tcIndex)) {
          closeThinkingBeforeContent()
          // Close previous content block if needed
          if (state.blockIndex > 0 || contentDelta != null) {
            results.push(
              formatSseEvent("content_block_stop", {
                type: "content_block_stop",
                index: state.blockIndex,
              })
            )
            state.blockIndex++
          }

          // New tool call
          state.hasToolCall = true
          const toolId = (tc.id as string) || `call_${crypto.randomUUID()}`
          const toolName = (func?.name as string) || ""

          state.activeToolCalls.set(tcIndex, {
            id: toolId,
            name: toolName,
            arguments: "",
          })

          results.push(
            formatSseEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: {
                type: "tool_use",
                id: toolId,
                name: toolName,
                input: {},
              },
            })
          )

          // Emit initial empty delta
          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: "" },
            })
          )
        }

        // Argument delta
        const argDelta = func?.arguments as string | undefined
        if (argDelta) {
          const tc_state = state.activeToolCalls.get(tcIndex)
          if (tc_state) {
            tc_state.arguments += argDelta
          }

          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: argDelta },
            })
          )
        }
      }
    }

    // Handle finish
    if (finishReason) {
      closeThinkingBeforeContent()
      // Close the current content block
      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.blockIndex++

      // Determine stop reason
      let stopReason: string
      if (finishReason === "tool_calls" || state.hasToolCall) {
        stopReason = "tool_use"
      } else if (finishReason === "length") {
        stopReason = "max_tokens"
      } else {
        stopReason = "end_turn"
      }

      // Extract usage from the chunk if available
      const chunkUsage = chunk.usage as Record<string, unknown> | undefined
      const inputTokens = (chunkUsage?.prompt_tokens as number) || 0
      const outputTokens = (chunkUsage?.completion_tokens as number) || 0

      results.push(
        formatSseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        })
      )
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
    }

    return results
  }

  /**
   * Emit final stream end events (fallback if finish_reason was missed).
   */
  private *emitStreamEnd(state: StreamState): Generator<string, void, unknown> {
    const pendingThinking = this.closeThinkingBlock(state)
    for (const event of pendingThinking) {
      yield event
    }

    const stopReason = state.hasToolCall ? "tool_use" : "end_turn"

    yield formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    yield formatSseEvent("message_stop", { type: "message_stop" })
  }
}
