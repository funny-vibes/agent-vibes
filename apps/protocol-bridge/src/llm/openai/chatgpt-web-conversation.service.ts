import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "node:crypto"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import { CodexService } from "./codex.service"
import type { CodexRealtimeAccountLease } from "./codex-realtime-account"
import { UpstreamRequestAbortedError } from "../shared/abort-signal"
import type { ChatGptWebImage } from "./chatgpt-web-image"
import {
  ChatGptWebSessionError,
  ChatGptWebSessionStore,
} from "./chatgpt-web-session"

/**
 * ChatGPT Web text backend — `chatgpt.com/backend-api/conversation`.
 *
 * This is the same account as the Codex CLI login but a different quota
 * bucket, and it reaches models Codex does not expose (`*-pro`, `o3-pro`,
 * Deep Research). Accounts are leased from the same CodexService pool the
 * voice path uses, so round-robin, cooldowns and per-account proxies apply
 * here unchanged. The OAuth bearer is accepted by chatgpt.com as-is; no
 * browser cookie extraction is involved beyond the Cloudflare handshake that
 * ChatGptWebSessionStore performs.
 *
 * Wire notes that shape the code below:
 *
 *   - The response stream repeats **whole message snapshots** rather than
 *     deltas, so text is diffed against what was already emitted.
 *   - Reasoning arrives as separate messages with `content_type` of
 *     `thoughts` / `reasoning_recap`, which are surfaced separately from the
 *     user-visible `text` channel.
 *   - Custom `tools` in the request body are silently ignored by upstream —
 *     there is no native function calling here. A system message, however, is
 *     honoured, which is what makes prompt-directed behaviour possible.
 *   - There is no inline image: bytes go to the account's file store first
 *     (`backend-api/files`), and the message names the result through a
 *     `multimodal_text` content block. See `attachImages` below.
 */

const ORIGIN = "https://chatgpt.com"
const MODEL_CACHE_TTL_MS = 10 * 60 * 1_000

/**
 * Citation anchors the web UI renders as footnote chips rather than text.
 * They arrive as private-use codepoints: a paired \u{E200}…\u{E201} span
 * wrapping the reference payload, plus bare markers in the same block. The
 * paired form is listed first so a full span is consumed before the
 * single-character branch can nibble at its opening anchor.
 */
const CITATION_MARKERS = /\u{E200}[\s\S]*?\u{E201}|[\u{E200}-\u{E206}]/gu

export interface ChatGptWebMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
  /**
   * Images attached to this message, already decoded.
   *
   * Left out for the text-only turns that are nearly all of them, which is
   * what keeps their payload exactly what it was before images existed.
   */
  readonly images?: readonly ChatGptWebImage[]
}

/** One image after upstream has taken the bytes and named them. */
interface ChatGptWebAttachment {
  readonly fileId: string
  readonly assetPointer: string
  readonly name: string
  readonly size: number
  readonly mimeType: string
  readonly width: number
  readonly height: number
}

/** A message with its images turned into ids upstream will accept. */
interface AttachedMessage extends ChatGptWebMessage {
  readonly attachments?: readonly ChatGptWebAttachment[]
}

export interface ChatGptWebRequest {
  readonly model: string
  readonly messages: readonly ChatGptWebMessage[]
  /**
   * ChatGPT's own depth for this turn — `min`, `standard`, `extended` or
   * `max`. Left out, upstream applies the model's default.
   */
  readonly thinkingEffort?: string | null
  /**
   * The conversation to continue. Left out, the turn starts a new one.
   *
   * Continuing means upstream already holds the history, so `messages` should
   * carry only what is new — anything else is said twice in the thread.
   */
  readonly conversationId?: string | null
  /** The message the new one answers; required to continue a thread. */
  readonly parentMessageId?: string | null
  readonly signal?: AbortSignal
}

export type ChatGptWebEvent =
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "reasoning"; readonly delta: string }
  | {
      readonly kind: "done"
      readonly conversationId?: string
      /** The assistant message the next turn should answer. */
      readonly messageId?: string
    }

interface CachedCatalog {
  slugs: Set<string>
  fetchedAt: number
}

export class ChatGptWebError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ChatGptWebError"
  }
}

@Injectable()
export class ChatGptWebConversationService {
  private readonly logger = new Logger(ChatGptWebConversationService.name)
  private catalog: CachedCatalog | null = null

  constructor(
    private readonly codex: CodexService,
    private readonly sessions: ChatGptWebSessionStore,
    private readonly configService: ConfigService
  ) {}

  /**
   * The connector that carries Cursor's tools, if one is configured.
   *
   * Naming it in the payload is what makes the model able to call those tools.
   * It was believed this only worked for a request the web app itself built —
   * measured otherwise: a request with a body of our own construction
   * activated the connector, and the tool call reached this bridge. What the
   * app does provide is a fresh single-use sentinel and a session the edge
   * trusts, both of which this transport already obtains for every turn.
   */
  private connectorHint(): string | undefined {
    const id = this.configService
      .get<string>("CHATGPT_WEB_CONNECTOR_ID", "")
      .trim()
    return id ? `plugin:${id}` : undefined
  }

  /**
   * Lease an account from the shared Codex pool. The caller owns the lease and
   * must settle it with `accept()` or `reject()`.
   */
  private async lease(): Promise<CodexRealtimeAccountLease> {
    if (this.codex.getChatGptWebRealtimeAccountCount() === 0) {
      throw new ChatGptWebError(
        401,
        "chatgpt_web_not_authenticated",
        "No ChatGPT account is connected — sign in with the Codex OAuth flow first"
      )
    }
    const lease = await this.codex.acquireChatGptWebRealtimeAccount()
    if (!lease) {
      throw new ChatGptWebError(
        503,
        "chatgpt_web_no_account_available",
        "Every ChatGPT account is on cooldown — try again shortly"
      )
    }
    return lease
  }

  private baseHeaders(
    lease: CodexRealtimeAccountLease
  ): Promise<Record<string, string>> {
    return this.sessions.baseHeaders(
      lease.accountKey,
      lease.accessToken,
      accountIdFromToken(lease.accessToken)
    )
  }

  private async headers(
    lease: CodexRealtimeAccountLease,
    base: Record<string, string>
  ): Promise<Record<string, string>> {
    const sentinel = await this.sessions.sentinelHeaders(lease.accountKey, base)
    // No device-id override here: baseHeaders already carries the `oai-did`
    // upstream handed back during the handshake, and header and cookie
    // agreeing is what the browser does.
    return { ...base, ...sentinel }
  }

  /**
   * Per-account proxy dispatcher, mirroring the Claude and Codex paths so an
   * account routed through a proxy stays on it here too.
   */
  private proxyDispatcher(lease: CodexRealtimeAccountLease): unknown {
    const proxyUrl = lease.proxyUrl
    if (!proxyUrl) return undefined
    try {
      switch (new URL(proxyUrl).protocol) {
        case "http:":
          return new HttpProxyAgent(proxyUrl)
        case "https:":
          return new HttpsProxyAgent(proxyUrl)
        case "socks4:":
        case "socks5:":
        case "socks5h:":
          return new SocksProxyAgent(proxyUrl)
        default:
          this.logger.warn(`Unsupported proxy scheme for ${lease.label}`)
          return undefined
      }
    } catch {
      this.logger.warn(`Ignoring malformed proxy URL for ${lease.label}`)
      return undefined
    }
  }

  /**
   * Slugs upstream currently offers. Cached briefly — the list changes when
   * OpenAI ships a model, not between requests.
   */
  /**
   * The message a new turn in this conversation should answer.
   *
   * ChatGPT calls it `current_node`: the leaf of the thread as it stands right
   * now. Asking upstream rather than trusting what was last seen here is what
   * lets a conversation be carried on by hand in the web UI and then picked up
   * again from this side — the next turn follows what was actually said, not
   * what this process happens to remember.
   *
   * Null when it cannot be read: the caller then starts a fresh conversation
   * rather than grafting a turn onto a branch nobody asked for.
   */
  async currentNode(conversationId: string): Promise<string | null> {
    const id = conversationId.trim()
    if (!id) return null
    const lease = await this.lease()
    try {
      const base = await this.sessions.baseHeaders(
        lease.accountKey,
        lease.accessToken,
        accountIdFromToken(lease.accessToken)
      )
      const response = await fetch(
        `${ORIGIN}/backend-api/conversation/${encodeURIComponent(id)}`,
        {
          headers: { ...base, accept: "application/json" },
          dispatcher: this.proxyDispatcher(lease),
          signal: AbortSignal.timeout(this.sessions.settings.requestTimeoutMs),
        } as RequestInit
      )
      if (!response.ok) {
        lease.reject(response.status, "conversation read rejected")
        return null
      }
      lease.accept()
      const payload = (await response.json()) as { current_node?: unknown }
      return typeof payload.current_node === "string"
        ? payload.current_node
        : null
    } catch (error) {
      lease.reject(502, describe(error))
      return null
    }
  }

  async listModelSlugs(): Promise<string[]> {
    if (
      this.catalog &&
      Date.now() - this.catalog.fetchedAt < MODEL_CACHE_TTL_MS
    )
      return [...this.catalog.slugs]

    const lease = await this.lease()
    let response: Response
    try {
      const base = await this.sessions.baseHeaders(
        lease.accountKey,
        lease.accessToken,
        accountIdFromToken(lease.accessToken)
      )
      response = await fetch(`${ORIGIN}/backend-api/models`, {
        headers: { ...base, accept: "application/json" },
        dispatcher: this.proxyDispatcher(lease),
        signal: AbortSignal.timeout(this.sessions.settings.requestTimeoutMs),
      } as RequestInit)
    } catch (error) {
      lease.reject(502, describe(error))
      throw error
    }
    if (!response.ok) {
      lease.reject(response.status, "model listing rejected")
      throw new ChatGptWebError(
        response.status === 401 ? 401 : 502,
        "chatgpt_web_models_failed",
        `Model listing returned ${response.status}`
      )
    }
    lease.accept()
    const payload = (await response.json()) as {
      models?: { slug?: string }[]
    }
    const slugs = new Set(
      (payload.models ?? [])
        .map((m) => (m.slug || "").trim())
        .filter((slug) => slug.length > 0)
    )
    this.catalog = { slugs, fetchedAt: Date.now() }
    return [...slugs]
  }

  /**
   * Map a caller-facing id onto an upstream slug.
   *
   * Callers write `gpt-5.5` or `web/gpt-5.5`; upstream spells most slugs with
   * dashes (`gpt-5-5`) but keeps dots for the `-wm` family, so both forms are
   * tried against the live catalog rather than guessed at.
   */
  async resolveSlug(model: string): Promise<string | null> {
    const requested = model.trim().replace(/^web[/:]/i, "")
    if (!requested) return null
    const slugs = new Set(await this.listModelSlugs())

    const candidates = [
      requested,
      requested.replace(/\./g, "-"),
      requested.replace(/-/g, "."),
    ]
    for (const candidate of candidates) {
      if (slugs.has(candidate)) return candidate
    }
    return null
  }

  async supportsModel(model: string): Promise<boolean> {
    return (await this.resolveSlug(model).catch(() => null)) !== null
  }

  /**
   * Stream one turn. Each yielded event carries only the newly added text so
   * downstream translators can forward it as a delta unchanged.
   */
  async *stream(req: ChatGptWebRequest): AsyncGenerator<ChatGptWebEvent> {
    yield* this.readStream(await this.openTurn(req))
  }

  /** Send one turn and hand back its response body, or throw trying. */
  private async openTurn(
    req: ChatGptWebRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const slug = await this.resolveSlug(req.model)
    if (!slug) {
      throw new ChatGptWebError(
        400,
        "chatgpt_web_unknown_model",
        `ChatGPT Web does not offer a model named "${req.model}"`
      )
    }

    const lease = await this.lease()
    const base = await this.baseHeaders(lease)
    // Uploaded before the turn opens, never alongside it: the message can only
    // name a file the account's store already holds. An upload that fails
    // throws from here rather than sending the turn anyway — an answer to a
    // question whose picture went missing is worse than no answer at all.
    const carried = await this.attachImages(lease, base, req.messages)
    const body = this.buildPayload(slug, carried, req.thinkingEffort, {
      conversationId: req.conversationId,
      parentMessageId: req.parentMessageId,
    })

    let response: Response
    try {
      response = await fetch(`${ORIGIN}/backend-api/conversation`, {
        method: "POST",
        headers: await this.headers(lease, base),
        body: JSON.stringify(body),
        dispatcher: this.proxyDispatcher(lease),
        signal: req.signal,
      } as RequestInit)
    } catch (error) {
      // A cancelled turn aborts this fetch, and that abort surfaces here
      // looking exactly like an unreachable upstream. Charging it to the
      // account is how one cancel used to take the whole pool down for a
      // minute, so the request that followed a second later had no account
      // left to lease.
      if (req.signal?.aborted) {
        lease.abandon()
        throw new UpstreamRequestAbortedError(describe(error))
      }
      lease.reject(502, describe(error))
      throw new ChatGptWebError(
        502,
        "chatgpt_web_unreachable",
        `Conversation request failed: ${describe(error)}`
      )
    }

    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => "")).slice(0, 400)
      // A 403 here is the Cloudflare/device check, not a credential problem;
      // drop the handshake so the next attempt re-warms rather than replaying
      // a jar upstream has stopped trusting.
      if (response.status === 403) this.sessions.invalidate(lease.accountKey)
      lease.reject(response.status, detail)
      throw new ChatGptWebError(
        response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
        response.status === 403
          ? "chatgpt_web_device_rejected"
          : "chatgpt_web_upstream_error",
        `Conversation returned ${response.status}: ${detail}`
      )
    }

    lease.accept()
    return response.body
  }

  /**
   * Put every attached image on the account's file store, and hand back the
   * same messages with ids upstream will accept in their place.
   *
   * Three calls per image, which is what the web app itself makes: ask for an
   * upload slot, PUT the bytes to the signed URL that comes back, then tell
   * the backend the upload finished. Text-only messages pass straight
   * through and make no calls at all.
   */
  private async attachImages(
    lease: CodexRealtimeAccountLease,
    base: Record<string, string>,
    messages: readonly ChatGptWebMessage[]
  ): Promise<readonly AttachedMessage[]> {
    if (!messages.some((message) => message.images?.length)) return messages

    const carried: AttachedMessage[] = []
    for (const message of messages) {
      if (!message.images?.length) {
        carried.push(message)
        continue
      }
      const attachments: ChatGptWebAttachment[] = []
      for (const image of message.images) {
        attachments.push(await this.uploadImage(lease, base, image))
      }
      carried.push({ ...message, attachments })
    }
    return carried
  }

  private async uploadImage(
    lease: CodexRealtimeAccountLease,
    base: Record<string, string>,
    image: ChatGptWebImage
  ): Promise<ChatGptWebAttachment> {
    const size = image.bytes.byteLength
    // `width`/`height` ride along with the slot request because upstream
    // stores them against the file; the asset pointer in the message repeats
    // them, and a mismatch is what makes the web UI render a broken tile.
    const slot = (await this.fileCall(lease, base, "files", {
      file_name: image.fileName,
      file_size: size,
      use_case: "multimodal",
      mime_type: image.mimeType,
      width: image.width,
      height: image.height,
    })) as { file_id?: unknown; upload_url?: unknown }

    const fileId = typeof slot.file_id === "string" ? slot.file_id : ""
    const uploadUrl = typeof slot.upload_url === "string" ? slot.upload_url : ""
    if (!fileId || !uploadUrl) {
      // A 200 that names neither is upstream's fault, not the account's, but
      // the lease is open and something has to settle it.
      lease.reject(502, "file upload slot missing file_id or upload_url")
      throw new ChatGptWebError(
        502,
        "chatgpt_web_upload_failed",
        `ChatGPT Web offered no upload slot for ${image.fileName}`
      )
    }

    let put: Response
    try {
      put = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": image.mimeType,
          // The signed URL points at blob storage, which refuses a PUT that
          // does not say what kind of blob it is holding.
          "x-ms-blob-type": "BlockBlob",
          "x-ms-version": "2020-04-08",
          // Deliberately no authorization and no cookie: the signature in the
          // URL is the whole credential, and the account's bearer has no
          // business being sent to a storage host.
        },
        body: image.bytes,
        dispatcher: this.proxyDispatcher(lease),
        signal: AbortSignal.timeout(this.sessions.settings.requestTimeoutMs),
      } as RequestInit)
    } catch (error) {
      // Abandoned rather than rejected throughout this block: the PUT goes to
      // blob storage, which has no opinion about the account. Charging it
      // would cool down a healthy account over a storage hiccup, and with a
      // one-account pool the next request would have nowhere to go.
      lease.abandon()
      throw new ChatGptWebError(
        502,
        "chatgpt_web_upload_failed",
        `Uploading ${image.fileName} to ChatGPT Web failed: ${describe(error)}`
      )
    }
    if (!put.ok) {
      const detail = (await put.text().catch(() => "")).slice(0, 300)
      lease.abandon()
      throw new ChatGptWebError(
        502,
        "chatgpt_web_upload_failed",
        `Uploading ${image.fileName} to ChatGPT Web returned ${put.status}: ${detail}`
      )
    }

    await this.fileCall(
      lease,
      base,
      `files/${encodeURIComponent(fileId)}/uploaded`,
      {}
    )

    // The id is the one thing worth having when an image arrives but the
    // model does not see it: it says which scheme the pointer was built with.
    this.logger.debug(
      `Uploaded ${image.fileName} (${size} bytes) to ChatGPT Web as ${fileId}`
    )
    return {
      fileId,
      assetPointer: assetPointer(fileId),
      name: image.fileName,
      size,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
    }
  }

  /**
   * One JSON call against the file store, with the lease settled on failure.
   *
   * The sentinel token is not fetched for these: it is single-use and gates
   * `conversation` alone, and spending one here would leave the turn itself
   * without one.
   */
  private async fileCall(
    lease: CodexRealtimeAccountLease,
    base: Record<string, string>,
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetch(`${ORIGIN}/backend-api/${path}`, {
        method: "POST",
        headers: { ...base, accept: "application/json" },
        body: JSON.stringify(body),
        dispatcher: this.proxyDispatcher(lease),
        signal: AbortSignal.timeout(this.sessions.settings.requestTimeoutMs),
      } as RequestInit)
    } catch (error) {
      lease.reject(502, describe(error))
      throw new ChatGptWebError(
        502,
        "chatgpt_web_upload_failed",
        `ChatGPT Web file upload (${path}) failed: ${describe(error)}`
      )
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300)
      if (response.status === 403) this.sessions.invalidate(lease.accountKey)
      lease.reject(response.status, detail)
      throw new ChatGptWebError(
        response.status === 401 ? 401 : 502,
        "chatgpt_web_upload_failed",
        `ChatGPT Web file upload (${path}) returned ${response.status}: ${detail}`
      )
    }
    return (await response.json().catch(() => ({}))) as Record<string, unknown>
  }

  private buildPayload(
    slug: string,
    messages: readonly AttachedMessage[],
    thinkingEffort?: string | null,
    thread?: {
      conversationId?: string | null
      parentMessageId?: string | null
    }
  ): Record<string, unknown> {
    const now = Date.now() / 1_000
    const hint = this.connectorHint()
    return {
      action: "next",
      ...(hint ? { system_hints: [hint] } : {}),
      messages: messages.map((message) => ({
        id: crypto.randomUUID(),
        author: { role: message.role },
        create_time: now,
        content: messageContent(message),
        metadata: {
          serialization_metadata: { custom_symbol_offsets: [] },
          ...(message.attachments?.length
            ? { attachments: message.attachments.map(attachmentRecord) }
            : {}),
          ...(hint ? { system_hints: [hint] } : {}),
        },
      })),
      // A new conversation has nothing to answer, and upstream accepts any id
      // as the root. Continuing one has to name the message it follows, or the
      // turn is grafted onto the wrong branch.
      parent_message_id: thread?.parentMessageId || crypto.randomUUID(),
      ...(thread?.conversationId
        ? { conversation_id: thread.conversationId }
        : {}),
      model: slug,
      timezone_offset_min: this.sessions.settings.timezoneOffsetMinutes,
      timezone: this.sessions.settings.timezone,
      // Kept in history on purpose. A turn run from here is a conversation on
      // the account like any other: it belongs in the sidebar, where it can be
      // opened, read and carried on by hand. Hiding it would make this line
      // the one place a conversation goes to disappear.
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_rate_limit: false,
      websocket_request_id: crypto.randomUUID(),
      // Sent only when asked for. The field is optional upstream, and leaving
      // it out is how you say "whatever this model normally does".
      ...(thinkingEffort ? { thinking_effort: thinkingEffort } : {}),
    }
  }

  /**
   * Translate the upstream SSE into deltas.
   *
   * Snapshots arrive repeatedly for the same message id and may also arrive
   * out of order across ids, so emitted length is tracked per id and any
   * snapshot that does not extend what was already sent is dropped.
   */
  private async *readStream(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<ChatGptWebEvent> {
    const decoder = new TextDecoder()
    const emitted = new Map<string, number>()
    let conversationId: string | undefined
    let messageId: string | undefined
    let buffer = ""

    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (raw === "[DONE]") {
          yield { kind: "done", conversationId, messageId }
          return
        }

        let event: Record<string, unknown>
        try {
          event = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue
        }

        if (typeof event.conversation_id === "string")
          conversationId = event.conversation_id

        // Upstream reports a refusal inside a perfectly ordinary 200 stream:
        //
        //   {"message":null,"conversation_id":"…","error":"Our systems have
        //    detected unusual activity coming from your system. …"}
        //
        // Dropping it — which is what `if (!message) continue` did, since these
        // frames carry `message: null` — left the turn to run to `[DONE]` with
        // nothing emitted, and the caller received an empty assistant message
        // with `finish_reason: "stop"`. A caller cannot tell that apart from a
        // model that genuinely answered with nothing, so a blocked account
        // looked like a model quirk: one consumer spent a morning tracing
        // "why is the assistant returning an empty string" through three
        // codebases before opening this stream and reading the sentence that
        // had been here all along.
        //
        // Say it instead. 429 when the wording is a rate or activity limit so
        // clients back off rather than retry, 502 otherwise.
        const upstreamError =
          typeof event.error === "string" && event.error.trim()
            ? event.error.trim()
            : undefined
        if (upstreamError) {
          const throttled =
            /unusual activity|rate limit|too many|cooldown|quota/i.test(
              upstreamError
            )
          throw new ChatGptWebError(
            throttled ? 429 : 502,
            throttled ? "chatgpt_web_throttled" : "chatgpt_web_upstream_error",
            upstreamError
          )
        }

        const message = event.message as Record<string, unknown> | undefined
        if (!message) continue

        const author = message.author as { role?: string } | undefined
        if (author?.role !== "assistant") continue

        const content = message.content as
          | { content_type?: string; parts?: unknown[]; content?: unknown }
          | undefined
        if (!content) continue

        const id = typeof message.id === "string" ? message.id : "anonymous"
        if (id !== "anonymous") messageId = id
        const text = extractText(content)
        if (!text) continue

        const already = emitted.get(id) ?? 0
        if (text.length <= already) continue
        emitted.set(id, text.length)

        const delta = text.slice(already)
        yield content.content_type === "text"
          ? { kind: "text", delta }
          : { kind: "reasoning", delta }
      }
    }

    yield { kind: "done", conversationId, messageId }
  }
}

/**
 * The ChatGPT account id upstream expects in `chatgpt-account-id`, read from
 * the OAuth access token's own claims so it always matches the bearer being
 * sent. An unparseable token yields an empty id rather than throwing —
 * upstream's own 401 is the more useful error in that case.
 */
function accountIdFromToken(accessToken: string): string {
  try {
    const segment = accessToken.split(".")[1]
    if (!segment) return ""
    const claims = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8")
    ) as Record<string, unknown>
    const auth = claims["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: unknown }
      | undefined
    return typeof auth?.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : ""
  } catch {
    return ""
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How a message says what it is carrying.
 *
 * A text-only message keeps the `text` block it has always sent, byte for
 * byte. Only a message with an image switches to `multimodal_text`, where the
 * pointers come first and the prompt last — the order the web app uses, and
 * the one the model reads as "here is a picture, now the question about it".
 */
function messageContent(message: AttachedMessage): Record<string, unknown> {
  if (!message.attachments?.length) {
    return { content_type: "text", parts: [message.content] }
  }
  return {
    content_type: "multimodal_text",
    parts: [
      ...message.attachments.map((attachment) => ({
        content_type: "image_asset_pointer",
        asset_pointer: attachment.assetPointer,
        size_bytes: attachment.size,
        width: attachment.width,
        height: attachment.height,
      })),
      message.content,
    ],
  }
}

/**
 * The same file again, in the shape the message metadata wants it.
 *
 * Upstream needs both: the part in `parts` is what the model is shown, and
 * this record is what the thread renders as an attachment chip. A message
 * carrying only one of the two arrives half-formed.
 */
function attachmentRecord(
  attachment: ChatGptWebAttachment
): Record<string, unknown> {
  return {
    id: attachment.fileId,
    size: attachment.size,
    name: attachment.name,
    mime_type: attachment.mimeType,
    width: attachment.width,
    height: attachment.height,
    source: "local",
  }
}

/**
 * The scheme an asset pointer uses to name a file.
 *
 * ChatGPT changed both at once: the older `file-…` ids are addressed as
 * `file-service://`, the newer `file_…` ones as `sediment://`. Reading the
 * scheme off the id upstream just handed back keeps either working without a
 * version to keep in step.
 */
function assetPointer(fileId: string): string {
  return fileId.startsWith("file_")
    ? `sediment://${fileId}`
    : `file-service://${fileId}`
}

/** Pull renderable text out of a message's content block. */
function extractText(content: {
  content_type?: string
  parts?: unknown[]
  content?: unknown
}): string {
  const raw =
    Array.isArray(content.parts) && typeof content.parts[0] === "string"
      ? content.parts[0]
      : typeof content.content === "string"
        ? content.content
        : ""
  return raw.replace(CITATION_MARKERS, "")
}

export { ChatGptWebSessionError }
