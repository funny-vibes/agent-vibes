import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "node:crypto"
import { parseModelRequest } from "../../llm/shared/model-request"
import {
  ChatGptWebConversationService,
  ChatGptWebError,
  type ChatGptWebEvent,
  type ChatGptWebMessage,
} from "../../llm/openai/chatgpt-web-conversation.service"
import {
  readImageUrl,
  type ChatGptWebImage,
} from "../../llm/openai/chatgpt-web-image"
import { webGptTarget } from "../../llm/shared/model-registry"
import type {
  OpenAiChatCompletionRequest,
  OpenAiChatCompletionResponse,
  OpenAiChatMessage,
  OpenAiContentPart,
  OpenAiResponsesRequest,
} from "./openai-types"

/**
 * Adapts the ChatGPT Web text backend onto the OpenAI-compatible surface
 * served at `/v1/web-gpt/*`.
 *
 * The upstream conversation API has no native function calling — a `tools`
 * array in the request is accepted and then ignored by upstream — so requests
 * carrying tools are rejected here rather than silently answered without
 * them, which would strand an agent waiting for a tool call that can never
 * arrive. Text and reasoning stream through unchanged.
 *
 * An `image_url` part is uploaded to the account's file store and named from
 * the message. One that cannot be delivered is refused by name: dropping it
 * is what used to leave the model answering as though nothing was attached.
 */

interface ThreadRef {
  conversationId?: string
  messageId?: string
}

/** How many answered turns keep their place in the thread map. */
const REMEMBERED_RESPONSES = 500

@Injectable()
export class ChatGptWebProtocolService {
  private readonly logger = new Logger(ChatGptWebProtocolService.name)
  /**
   * Where each answer left its conversation.
   *
   * A caller continues by naming one — `conversation` for the thread itself,
   * or `previous_response_id` for the turn that produced it — and gets back a
   * thread that is a real conversation on the account, openable in the web UI.
   */
  private readonly threads = new Map<string, ThreadRef>()

  constructor(private readonly conversation: ChatGptWebConversationService) {}

  /**
   * Route a turn to whichever transport the request asks for.
   *
   * Only the browser transport can offer the model any tools, so tool use is
   * refused on the HTTP one rather than answered without them — an agent left
   * waiting for a call that can never arrive is worse than a clear error.
   */
  private async *run(
    model: string,
    messages: readonly ChatGptWebMessage[],
    hasTools: boolean,
    requestedDepth: string | undefined,
    thread: ThreadRef,
    signal?: AbortSignal
  ): AsyncGenerator<ChatGptWebEvent> {
    const named = stripLegacyBrowserPrefix(model)
    const { slug, thinkingEffort } = webGptTarget(named, requestedDepth)
    this.rejectToolUse(hasTools)
    const source = this.startHttpTurn(
      slug,
      messages,
      thinkingEffort,
      thread,
      signal
    )
    for await (const event of await source) {
      if (event.kind === "done") {
        // Kept even when the caller ignores the event: it is what the next
        // turn needs to land in the same thread.
        if (event.conversationId) thread.conversationId = event.conversationId
        if (event.messageId) thread.messageId = event.messageId
      }
      yield event
    }
  }

  /**
   * Start an HTTP turn, continuing a named conversation when there is one.
   *
   * Continuing means upstream already holds the history, so only the newest
   * user message is sent — repeating the rest would say it all twice in the
   * thread. The message it answers is read from upstream rather than from
   * memory, so a conversation carried on by hand in the web UI is picked up
   * where the person left it.
   */
  private async startHttpTurn(
    slug: string,
    messages: readonly ChatGptWebMessage[],
    thinkingEffort: string | null,
    thread: ThreadRef,
    signal?: AbortSignal
  ): Promise<AsyncGenerator<ChatGptWebEvent>> {
    const continuing = thread.conversationId
      ? await this.conversation.currentNode(thread.conversationId)
      : null
    if (thread.conversationId && !continuing) {
      this.logger.warn(
        `Could not read conversation ${thread.conversationId}; starting a new one`
      )
      thread.conversationId = undefined
    }
    return this.conversation.stream({
      model: slug,
      messages: continuing ? lastUserMessage(messages) : messages,
      thinkingEffort,
      conversationId: continuing ? thread.conversationId : undefined,
      parentMessageId: continuing,
      signal,
    })
  }

  /** The thread a request asked to continue, if it named one. */
  private threadFromRequest(req: Record<string, unknown>): ThreadRef {
    const conversation = req.conversation
    if (typeof conversation === "string" && conversation.trim()) {
      return { conversationId: conversation.trim() }
    }
    const previous = req.previous_response_id
    if (typeof previous === "string" && previous.trim()) {
      return { ...this.threads.get(previous.trim()) }
    }
    return {}
  }

  private rememberThread(responseId: string, thread: ThreadRef): void {
    if (!thread.conversationId) return
    this.threads.set(responseId, { ...thread })
    if (this.threads.size > REMEMBERED_RESPONSES) {
      const oldest = this.threads.keys().next().value
      if (oldest) this.threads.delete(oldest)
    }
  }

  listModelSlugs(): Promise<string[]> {
    return this.conversation.listModelSlugs()
  }

  private rejectToolUse(hasTools: boolean): void {
    if (!hasTools) return
    throw new ChatGptWebError(
      400,
      "chatgpt_web_tools_unsupported",
      "ChatGPT Web has no native function calling: upstream ignores the " +
        "`tools` field, so a tool-using request cannot be served here. Use a " +
        "Codex-backed model for agent turns."
    )
  }

  // ── Chat Completions ──────────────────────────────────────────────────

  async createChatCompletion(
    req: OpenAiChatCompletionRequest
  ): Promise<OpenAiChatCompletionResponse> {
    const messages = withResponseFormat(
      normalizeChatMessages(req.messages),
      req.response_format
    )
    const thread = this.threadFromRequest(req)
    const id = `chatcmpl-${randomId()}`

    let text = ""
    let reasoning = ""
    for await (const event of this.run(
      req.model,
      messages,
      (req.tools?.length ?? 0) > 0,
      requestedDepth(req.model, req.reasoning_effort),
      thread
    )) {
      if (event.kind === "text") text += event.delta
      else if (event.kind === "reasoning") reasoning += event.delta
    }
    this.rememberThread(id, thread)

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: req.model,
      // Additive, and the only way a chat-completions caller learns which
      // conversation to name next time.
      ...(thread.conversationId ? { conversation: thread.conversationId } : {}),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            // A JSON-mode caller parses this directly, and the web backend
            // still tends to fence its answer however the prompt asks.
            content: req.response_format ? unfenceJson(text) : text,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    } as OpenAiChatCompletionResponse
  }

  async *createChatCompletionStream(
    req: OpenAiChatCompletionRequest
  ): AsyncGenerator<string, void, unknown> {
    // Deltas cannot be unfenced after the fact, so the instruction carries the
    // whole contract here: it forbids the fence rather than stripping it.
    const messages = withResponseFormat(
      normalizeChatMessages(req.messages),
      req.response_format
    )
    const thread = this.threadFromRequest(req)
    const id = `chatcmpl-${randomId()}`
    const created = Math.floor(Date.now() / 1_000)

    const frame = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: req.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`

    yield frame({ role: "assistant", content: "" }, null)
    for await (const event of this.run(
      req.model,
      messages,
      (req.tools?.length ?? 0) > 0,
      requestedDepth(req.model, req.reasoning_effort),
      thread
    )) {
      if (event.kind === "text") yield frame({ content: event.delta }, null)
      else if (event.kind === "reasoning")
        yield frame({ reasoning_content: event.delta }, null)
    }
    this.rememberThread(id, thread)
    yield frame({}, "stop")
    yield "data: [DONE]\n\n"
  }

  // ── Responses API ─────────────────────────────────────────────────────

  async createResponse(
    req: OpenAiResponsesRequest
  ): Promise<Record<string, unknown>> {
    const messages = normalizeResponsesInput(req)
    const thread = this.threadFromRequest(
      req as unknown as Record<string, unknown>
    )
    const id = `resp_${randomId()}`

    let text = ""
    for await (const event of this.run(
      req.model,
      messages,
      (req.tools?.length ?? 0) > 0,
      requestedDepth(req.model, undefined, req.reasoning),
      thread
    )) {
      if (event.kind === "text") text += event.delta
    }
    this.rememberThread(id, thread)

    return {
      id,
      object: "response",
      ...(thread.conversationId ? { conversation: thread.conversationId } : {}),
      created_at: Math.floor(Date.now() / 1_000),
      status: "completed",
      model: req.model,
      output: [
        {
          type: "message",
          id: `msg_${randomId()}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }
  }

  async *createResponseStream(
    req: OpenAiResponsesRequest,
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const messages = normalizeResponsesInput(req)
    const thread = this.threadFromRequest(
      req as unknown as Record<string, unknown>
    )
    const responseId = `resp_${randomId()}`
    const itemId = `msg_${randomId()}`
    const createdAt = Math.floor(Date.now() / 1_000)
    let sequence = 0

    const emit = (type: string, payload: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({
        type,
        sequence_number: sequence++,
        ...payload,
      })}\n\n`

    const envelope = (status: string, text: string) => ({
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model: req.model,
      output: [
        {
          type: "message",
          id: itemId,
          status: status === "completed" ? "completed" : "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    })

    yield emit("response.created", { response: envelope("in_progress", "") })
    yield emit("response.in_progress", {
      response: envelope("in_progress", ""),
    })
    yield emit("response.output_item.added", {
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
    yield emit("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })

    let text = ""
    for await (const event of this.run(
      req.model,
      messages,
      (req.tools?.length ?? 0) > 0,
      requestedDepth(req.model, undefined, req.reasoning),
      thread,
      signal
    )) {
      if (event.kind !== "text") continue
      text += event.delta
      yield emit("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: event.delta,
      })
    }

    yield emit("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    })
    yield emit("response.content_part.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    })
    yield emit("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        id: itemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    })
    this.rememberThread(responseId, thread)
    yield emit("response.completed", { response: envelope("completed", text) })
  }
}

// ── request normalisation ───────────────────────────────────────────────

/**
 * The depth a request asked for, wherever it chose to say it.
 *
 * Three spellings reach this surface and they all mean the same thing:
 * `reasoning_effort` on a chat completion, `reasoning.effort` on a response,
 * and the `model(level)` suffix this bridge accepts everywhere else. The
 * vocabulary may be OpenAI's, Cursor's or ChatGPT's own — `webGptThinkingEffort`
 * is what settles that, and what checks the answer against the model.
 */
/** Only what is new, for a thread that already holds the rest. */
function lastUserMessage(
  messages: readonly ChatGptWebMessage[]
): ChatGptWebMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === "user") return [message]
  }
  return messages.length ? [messages[messages.length - 1]!] : []
}

function requestedDepth(
  model: string,
  explicit?: string,
  fromReasoning?: { effort?: string }
): string | undefined {
  const suffix = parseModelRequest(model)
  const fromSuffix =
    suffix.hasSuffix && suffix.suffix?.kind === "level"
      ? suffix.suffix.level
      : undefined
  return explicit || fromReasoning?.effort || fromSuffix
}

/**
 * Flatten OpenAI content parts into the text and the images upstream takes.
 *
 * Image parts used to fall out here — anything without a `text` field was
 * mapped to the empty string and filtered away — so a caller that attached a
 * picture got an answer to the prompt alone, and the answer was usually that
 * no image had been provided. They are carried now, and an image that cannot
 * be carried is refused by name instead of vanishing.
 */
function flattenContent(
  content: string | OpenAiContentPart[] | null | undefined
): { text: string; images: ChatGptWebImage[] } {
  if (typeof content === "string") return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: "", images: [] }

  const text: string[] = []
  const images: ChatGptWebImage[] = []
  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const url = imageUrlOf(part)
    if (url !== null) {
      const read = readImageUrl(url, images.length)
      if (!read.ok) {
        throw new ChatGptWebError(
          400,
          "chatgpt_web_image_unsupported",
          `Image ${images.length + 1} cannot be sent to ChatGPT Web: ${read.reason}`
        )
      }
      images.push(read.image)
      continue
    }
    if (!("text" in part)) continue
    const value = (part as { text?: unknown }).text
    if (typeof value === "string" && value) text.push(value)
  }
  return { text: text.join("\n"), images }
}

/**
 * The URL an image part names, whichever surface it arrived from.
 *
 * Chat Completions spells it `image_url` with an object; the Responses API
 * spells it `input_image` and allows the bare string. Null means the part is
 * not an image at all.
 */
function imageUrlOf(part: object): string | null {
  const type = (part as { type?: unknown }).type
  if (type !== "image_url" && type !== "input_image") return null
  const value = (part as { image_url?: unknown }).image_url
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const url = (value as { url?: unknown }).url
    if (typeof url === "string") return url
  }
  return ""
}

function normalizeChatMessages(
  messages: readonly OpenAiChatMessage[]
): ChatGptWebMessage[] {
  const normalized: ChatGptWebMessage[] = []
  for (const message of messages ?? []) {
    // `developer` is OpenAI's newer spelling of a system message; `tool`
    // results cannot occur here because tool use is rejected upstream.
    const role =
      message.role === "developer"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : message.role === "system"
            ? "system"
            : "user"
    const { text, images } = flattenContent(message.content)
    // Upstream hangs an attachment off a user turn and nowhere else, so an
    // image on any other role is refused rather than quietly left behind.
    if (images.length && role !== "user") {
      throw new ChatGptWebError(
        400,
        "chatgpt_web_image_unsupported",
        `ChatGPT Web takes an image only on a user message; one arrived on a ${role} message`
      )
    }
    if (!text && !images.length) continue
    normalized.push({
      role,
      content: text,
      ...(images.length ? { images } : {}),
    })
  }
  return normalized
}

/**
 * ChatGPT Web has no structured-output mode: upstream ignores
 * `response_format` outright, so a `json_schema` caller receives prose — or a
 * bare scalar where it asked for an object — and fails to parse it. The
 * contract is restored the only way this backend honours, as an instruction
 * the model reads, and the schema travels with it so `strict` still means
 * something.
 *
 * The instruction rides on the last user message rather than a system turn of
 * its own: a continuing thread resends only that message, so a separate turn
 * would be dropped on every request after the first.
 */
function withResponseFormat(
  messages: ChatGptWebMessage[],
  format: OpenAiChatCompletionRequest["response_format"]
): ChatGptWebMessage[] {
  const type = typeof format?.type === "string" ? format.type : ""
  if (type !== "json_object" && type !== "json_schema") return messages

  const lines = [
    "Respond with a single JSON value and nothing else.",
    "Do not wrap it in a code fence and do not add commentary around it.",
    "Escape newlines and other control characters inside string values.",
  ]
  const schema = (format as { json_schema?: { schema?: unknown } })?.json_schema
    ?.schema
  if (type === "json_schema" && schema) {
    lines.push(
      "The JSON must validate against this schema:",
      JSON.stringify(schema),
      // Observed: asked for one `drill` object the model wanted to give two, so
      // it wrote `"drill":{…},{…}` — a second object where the next property
      // name belonged, which no parser accepts. Cardinality needs saying out
      // loud, because this backend treats the schema as advice either way.
      "Match the structure exactly. Where the schema declares an object, emit" +
        " exactly one object; only an array may hold several entries. Never" +
        " place a second value after one that is already complete."
    )
  }
  const instruction = lines.join("\n")

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role !== "user") continue
    const carried = messages.slice()
    // Spread rather than rebuild: a message carrying images has to keep them,
    // and a literal here would drop them on every json-mode request.
    carried[index] = {
      ...messages[index]!,
      content: `${messages[index]!.content}\n\n${instruction}`,
    }
    return carried
  }
  return [...messages, { role: "user", content: instruction }]
}

/** Strip a fence the model added anyway, so the caller can parse directly. */
function unfenceJson(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed)
  return fenced ? fenced[1]!.trim() : trimmed
}

function normalizeResponsesInput(
  req: OpenAiResponsesRequest
): ChatGptWebMessage[] {
  const messages: ChatGptWebMessage[] = []
  if (req.instructions?.trim())
    messages.push({ role: "system", content: req.instructions })

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input })
    return messages
  }

  for (const item of req.input ?? []) {
    const record = item as unknown as Record<string, unknown>
    if (record.type && record.type !== "message") continue
    const role = record.role === "assistant" ? "assistant" : "user"
    const { text, images } = flattenContent(
      record.content as string | OpenAiContentPart[] | null
    )
    if (images.length && role !== "user") {
      throw new ChatGptWebError(
        400,
        "chatgpt_web_image_unsupported",
        `ChatGPT Web takes an image only on a user message; one arrived on a ${role} message`
      )
    }
    if (!text && !images.length) continue
    messages.push({ role, content: text, ...(images.length ? { images } : {}) })
  }
  return messages
}

function randomId(): string {
  return crypto.randomBytes(12).toString("hex")
}

/**
 * Tolerate a `browser/` prefix from a configuration written when there were
 * two transports. There is one now, so the prefix names nothing — but a model
 * id carrying it should still resolve rather than 404.
 */
function stripLegacyBrowserPrefix(model: string): string {
  return parseModelRequest(model.trim().replace(/^browser[/:]/i, "")).baseModel
}
