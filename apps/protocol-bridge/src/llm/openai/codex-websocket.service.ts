import { readCodexResponseOutcome } from "./codex-response-outcome"
/**
 * Codex WebSocket Transport Service
 *
 * Implements WebSocket-based transport for the Codex Responses API.
 * Supports:
 * - WebSocket connection management with session reuse
 * - Automatic reconnection on connection loss
 * - Fallback to HTTP when WebSocket upgrade is rejected
 * - Prompt cache via request body prompt_cache_key
 * - Streaming and non-streaming modes
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_websockets_executor.go
 *
 * Protocol:
 *   The Codex WebSocket API uses the "responses_websockets=2026-02-06" beta.
 *   Each request is sent as a JSON message with type "response.create".
 *   Responses are received as individual JSON messages (not SSE-wrapped).
 *   The response.completed event signals end of response.
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import type { IncomingHttpHeaders } from "http"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import WebSocket from "ws"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import { UpstreamRequestAbortedError } from "../shared/abort-signal"
import {
  buildCodexBridgeNativeWebSocketHeaders,
  buildCodexWebSocketRequestBody,
  type CodexBridgeNativeTransportScope,
  type CodexForwardHeaders,
} from "./codex-header-utils"
import { CodexClientIdentityService } from "./codex-client-identity.service"

// ── Constants ──────────────────────────────────────────────────────────

const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
/**
 * 握手超时阈值。chatgpt.com codex 后端正常握手 < 1.5s；保留 5s 容忍轻度抖动，
 * 之前的 30s 会让网络异常时整个 turn 卡 30s 才回落到 HTTP。
 */
const WS_HANDSHAKE_TIMEOUT_MS = 5 * 1000
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

// ── Types ──────────────────────────────────────────────────────────────

export interface WebSocketSession {
  sessionId: string
  conn: WebSocket | null
  wsUrl: string
  requestTail: Promise<void>
  readerConn: WebSocket | null
  activeStream: SessionActiveStream | null
}

export interface WebSocketMessage {
  type: string
  [key: string]: unknown
}

export interface CodexWebSocketConnectionMetadata {
  turnState?: string
  modelsEtag?: string
  serverModel?: string
  reasoningIncluded: boolean
}

export interface CodexWebSocketError {
  status: number
  error: Record<string, unknown>
}

type WebSocketWithCodexMetadata = WebSocket & {
  __codexMetadata?: CodexWebSocketConnectionMetadata
}

interface SessionStreamQueueItem {
  data?: WebSocket.Data
  error?: Error
}

interface SessionActiveStream {
  conn: WebSocket
  queue: SessionStreamQueueItem[]
  waiter: (() => void) | null
  done: boolean
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexWebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(CodexWebSocketService.name)

  /** Active sessions keyed by session ID */
  private readonly sessions = new Map<string, WebSocketSession>()
  private readonly connToSession = new WeakMap<WebSocket, WebSocketSession>()
  private readonly connCloseOrigins = new WeakMap<WebSocket, string>()

  constructor(private readonly identity: CodexClientIdentityService) {}

  onModuleDestroy(): void {
    // Close all active sessions
    for (const [id] of this.sessions) {
      this.closeSession(id, "module_destroy")
    }
    this.sessions.clear()
  }

  // ── URL Conversion ─────────────────────────────────────────────────

  /**
   * Convert HTTP URL to WebSocket URL.
   * Ported from: codex_websockets_executor.go buildCodexResponsesWebsocketURL()
   */
  buildWebSocketUrl(httpUrl: string): string {
    try {
      const parsed = new URL(httpUrl.trim())
      if (parsed.protocol === "https:") {
        parsed.protocol = "wss:"
      } else if (parsed.protocol === "http:") {
        parsed.protocol = "ws:"
      }
      return parsed.toString()
    } catch (e) {
      throw new Error(
        `Failed to build WebSocket URL from ${httpUrl}: ${(e as Error).message}`
      )
    }
  }

  // ── Header Building ────────────────────────────────────────────────

  buildBridgeNativeWebSocketHeaders(
    token: string,
    isApiKey: boolean,
    scope: CodexBridgeNativeTransportScope,
    accountId?: string,
    workspaceId?: string,
    forwardHeaders?: CodexForwardHeaders,
    omitAccountId: boolean = false,
    useResponsesLite: boolean = false
  ): Record<string, string> {
    return buildCodexBridgeNativeWebSocketHeaders({
      token,
      isApiKey,
      ...scope,
      accountId,
      workspaceId,
      forwardHeaders,
      omitAccountId,
      useResponsesLite,
      identity: {
        version: this.identity.version(),
        userAgent: this.identity.userAgent(),
        originator: this.identity.originator(),
      },
    })
  }

  private readProxyEnvValue(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key] || process.env[key.toLowerCase()]
      const normalized = value?.trim()
      if (normalized) {
        return normalized
      }
    }

    return undefined
  }

  private resolveProxyUrl(
    wsUrl: string,
    proxyUrl?: string
  ): string | undefined {
    const explicitProxyUrl = proxyUrl?.trim()
    if (explicitProxyUrl && explicitProxyUrl.toLowerCase() !== "direct") {
      return explicitProxyUrl
    }

    const targetProtocol = (() => {
      try {
        return new URL(wsUrl).protocol
      } catch {
        try {
          return new URL(DEFAULT_CODEX_BASE_URL).protocol === "https:"
            ? "wss:"
            : "ws:"
        } catch {
          return "wss:"
        }
      }
    })()

    return targetProtocol === "ws:"
      ? this.readProxyEnvValue(["ALL_PROXY", "HTTP_PROXY"])
      : this.readProxyEnvValue(["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY"])
  }

  private buildProxyAgent(
    wsUrl: string,
    proxyUrl?: string
  ):
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    const resolvedProxyUrl = this.resolveProxyUrl(wsUrl, proxyUrl)
    if (!resolvedProxyUrl) return undefined

    const normalizedProxyUrl = resolvedProxyUrl.trim()
    if (!normalizedProxyUrl || normalizedProxyUrl.toLowerCase() === "direct") {
      return undefined
    }

    try {
      const proxyParsed = new URL(normalizedProxyUrl)
      const targetProtocol = new URL(wsUrl).protocol

      switch (proxyParsed.protocol) {
        case "http:":
          return targetProtocol === "ws:"
            ? new HttpProxyAgent(normalizedProxyUrl)
            : new HttpsProxyAgent(normalizedProxyUrl)
        case "https:":
          return new HttpsProxyAgent(normalizedProxyUrl)
        case "socks5:":
        case "socks5h:":
        case "socks4:":
        case "socks4a:":
          return new SocksProxyAgent(normalizedProxyUrl)
        default:
          this.logger.warn(
            `Unsupported WebSocket proxy scheme: ${proxyParsed.protocol}`
          )
          return undefined
      }
    } catch (e) {
      this.logger.warn(
        `Failed to configure WebSocket proxy: ${(e as Error).message}`
      )
      return undefined
    }
  }

  private readUpgradeHeader(
    headers: IncomingHttpHeaders,
    name: string
  ): string | undefined {
    const value = headers[name.toLowerCase()]
    if (Array.isArray(value)) {
      return value.find((item) => item.trim().length > 0)?.trim()
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
    return undefined
  }

  private captureConnectionMetadata(
    ws: WebSocket,
    headers: IncomingHttpHeaders
  ): void {
    const metadata: CodexWebSocketConnectionMetadata = {
      turnState: this.readUpgradeHeader(headers, "x-codex-turn-state"),
      modelsEtag: this.readUpgradeHeader(headers, "x-models-etag"),
      serverModel: this.readUpgradeHeader(headers, "openai-model"),
      reasoningIncluded: !!this.readUpgradeHeader(
        headers,
        "x-reasoning-included"
      ),
    }
    ;(ws as WebSocketWithCodexMetadata).__codexMetadata = metadata
    this.logger.debug(
      `[Codex][WS Upgrade] turn_state=${metadata.turnState ? "present" : "none"} ` +
        `models_etag=${metadata.modelsEtag ? "present" : "none"} ` +
        `server_model=${metadata.serverModel || "none"} ` +
        `reasoning_included=${metadata.reasoningIncluded}`
    )
  }

  getConnectionMetadata(
    ws: WebSocket
  ): CodexWebSocketConnectionMetadata | undefined {
    return (ws as WebSocketWithCodexMetadata).__codexMetadata
  }

  // ── Request Body Building ──────────────────────────────────────────

  /**
   * Wrap a Codex request body for WebSocket transport.
   * Ported from: codex_websockets_executor.go buildCodexWebsocketRequestBody()
   */
  buildWebSocketRequestBody(
    body: Record<string, unknown>,
    options: {
      useResponsesLite?: boolean
      forwardHeaders?: CodexForwardHeaders
      streamRequestStartMs?: number
      turnState?: string
    } = {}
  ): Record<string, unknown> {
    return buildCodexWebSocketRequestBody(body, options)
  }

  /**
   * 构建 warmup 请求体：在正常请求体基础上设置 generate: false。
   * 对齐官方 Codex CLI（client.rs:1272-1274）：
   *   if warmup { ws_payload.generate = Some(false); }
   *
   * 这让服务端只预热 prompt cache 而不生成响应。
   */
  buildWarmupRequestBody(
    body: Record<string, unknown>,
    options: {
      useResponsesLite?: boolean
      forwardHeaders?: CodexForwardHeaders
      streamRequestStartMs?: number
      turnState?: string
    } = {}
  ): Record<string, unknown> {
    return buildCodexWebSocketRequestBody(body, {
      ...options,
      warmup: true,
    })
  }

  /**
   * 在已建立的 WebSocket 连接上发送 warmup payload 并等待 response.completed。
   *
   * 对齐官方 Codex CLI（session_startup_prewarm.rs:228-238）：
   *   prewarm_websocket(prompt, model_info, ...) 发送完整的请求体（带 generate:false），
   *   然后在 prewarm_websocket 中等待 response.completed 事件后才返回。
   *
   * 超时后自动返回，避免阻塞后续实际请求。
   */
  async sendWarmupRequest(
    ws: WebSocket,
    warmupBody: Record<string, unknown>,
    timeoutMs: number = 15_000
  ): Promise<void> {
    const session = this.connToSession.get(ws)

    if (session?.conn === ws) {
      // 使用 session 模式：通过 session 的消息队列接收响应
      await this.sendWarmupViaSession(session, ws, warmupBody, timeoutMs)
    } else {
      // standalone 模式
      await this.sendWarmupViaStandalone(ws, warmupBody, timeoutMs)
    }
  }

  private async sendWarmupViaSession(
    session: WebSocketSession,
    ws: WebSocket,
    warmupBody: Record<string, unknown>,
    timeoutMs: number
  ): Promise<void> {
    if (session.activeStream) {
      this.logger.warn(
        `[Warmup] session ${session.sessionId} has active stream, skipping warmup payload`
      )
      return
    }

    const activeStream: SessionActiveStream = {
      conn: ws,
      queue: [],
      waiter: null,
      done: false,
    }
    session.activeStream = activeStream

    try {
      await this.sendRequestPayload(ws, warmupBody)

      const deadline = Date.now() + timeoutMs
      while (!activeStream.done && Date.now() < deadline) {
        if (activeStream.queue.length === 0) {
          const remaining = Math.max(deadline - Date.now(), 100)
          await Promise.race([
            new Promise<void>((resolve) => {
              activeStream.waiter = resolve
            }),
            new Promise<void>((resolve) => setTimeout(resolve, remaining)),
          ])
          continue
        }

        const item = activeStream.queue.shift()
        if (!item) continue
        if (item.error) {
          this.logger.warn(
            `[Warmup] session ${session.sessionId} error during warmup: ${item.error.message}`
          )
          break
        }
        if (!item.data) continue

        try {
          const parsed = this.parseWebSocketMessage(item.data)
          if (parsed?.type === "response.completed") {
            this.logger.debug(
              `[Warmup] session ${session.sessionId} warmup completed`
            )
            break
          }
        } catch {
          // 解析错误时继续等待
        }
      }
    } finally {
      if (session.activeStream === activeStream) {
        session.activeStream = null
      }
    }
  }

  private async sendWarmupViaStandalone(
    ws: WebSocket,
    warmupBody: Record<string, unknown>,
    timeoutMs: number
  ): Promise<void> {
    await this.sendRequestPayload(ws, warmupBody)

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ws.off("message", onMessage)
        resolve()
      }, timeoutMs)

      const onMessage = (data: WebSocket.Data) => {
        try {
          const parsed = this.parseWebSocketMessage(data)
          if (parsed?.type === "response.completed") {
            clearTimeout(timeout)
            ws.off("message", onMessage)
            resolve()
          }
        } catch {
          // 继续等待
        }
      }

      ws.on("message", onMessage)
    })
  }

  // ── Connection Management ──────────────────────────────────────────

  /**
   * Establish a WebSocket connection to the Codex upstream.
   * Returns a promise that resolves when the connection is open.
   */
  async connect(
    wsUrl: string,
    headers: Record<string, string>,
    proxyUrl?: string
  ): Promise<WebSocket> {
    const wsOptions: WebSocket.ClientOptions = {
      headers,
      handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: true,
    }

    const proxyAgent = this.buildProxyAgent(wsUrl, proxyUrl)
    if (proxyAgent) {
      wsOptions.agent =
        proxyAgent as unknown as WebSocket.ClientOptions["agent"]
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, wsOptions)

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("WebSocket handshake timeout"))
      }, WS_HANDSHAKE_TIMEOUT_MS)

      ws.on("open", () => {
        clearTimeout(timeout)
        this.logger.log(`WebSocket connected: ${wsUrl}`)
        resolve(ws)
      })

      ws.once("upgrade", (res) => {
        this.captureConnectionMetadata(ws, res.headers)
      })

      ws.on("error", (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      // Handle upgrade rejection (HTTP 101 Upgrade Required)
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timeout)
        let body = ""
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on("end", () => {
          reject(new CodexWebSocketUpgradeError(res.statusCode || 0, body))
        })
      })
    })
  }

  // ── Streaming via WebSocket ────────────────────────────────────────

  /**
   * Send a request via WebSocket and stream responses.
   * Returns an async generator yielding parsed JSON messages.
   *
   * This is the WebSocket equivalent of the HTTP SSE streaming.
   * Each message from the WebSocket is a complete JSON event
   * (not SSE-wrapped like the HTTP transport).
   */
  async *streamViaWebSocket(
    ws: WebSocket,
    requestBody: Record<string, unknown>
  ): AsyncGenerator<WebSocketMessage, void, unknown> {
    const session = this.connToSession.get(ws)
    if (session?.conn === ws) {
      yield* this.streamViaSessionWebSocket(session, ws, requestBody)
      return
    }

    yield* this.streamViaStandaloneWebSocket(ws, requestBody)
  }

  // ── Non-streaming via WebSocket ────────────────────────────────────

  /**
   * Send a request via WebSocket and collect the full response.
   * Returns the response.completed event data.
   *
   * The codex backend does not guarantee that `response.completed.response.output`
   * carries the aggregated message/reasoning/tool items — for many models the
   * final completed frame only contains usage + stop_reason, and the actual
   * content arrives on the intermediate `response.output_item.done` events
   * (the streaming translator rebuilds content from those, see
   * codex-response-translator.ts). The non-stream caller only reads the
   * completed frame, so without aggregation it would lose all text/tool output.
   *
   * We therefore accumulate every `response.output_item.done` item as the
   * stream progresses and, when the completed frame's `output` is missing or
   * empty, backfill it from the accumulated items before returning. This keeps
   * non-stream parity with the streaming path for both the Anthropic and OpenAI
   * inbound surfaces.
   */
  async sendViaWebSocket(
    ws: WebSocket,
    requestBody: Record<string, unknown>,
    options: {
      onMessage?: (msg: WebSocketMessage) => void
    } = {}
  ): Promise<WebSocketMessage> {
    const collectedItems: Array<Record<string, unknown>> = []

    for await (const msg of this.streamViaWebSocket(ws, requestBody)) {
      readCodexResponseOutcome(msg)
      options.onMessage?.(msg)
      if (msg.type === "response.output_item.done") {
        const item = msg.item as Record<string, unknown> | undefined
        if (item && typeof item === "object") {
          collectedItems.push(item)
        }
        continue
      }

      if (msg.type === "response.completed") {
        const response = (msg.response as Record<string, unknown>) || {}
        const existingOutput = response.output

        const hasUsableOutput =
          Array.isArray(existingOutput) && existingOutput.length > 0

        if (!hasUsableOutput && collectedItems.length > 0) {
          // Backfill the aggregated items so translateCodexToClaudeNonStream
          // can extract message text, reasoning, and tool calls.
          return {
            ...msg,
            response: { ...response, output: collectedItems },
          }
        }

        return msg
      }
    }
    throw new Error("WebSocket stream ended without response.completed")
  }

  // ── Session Management ─────────────────────────────────────────────

  /**
   * Get or create a session for connection reuse.
   */
  getOrCreateSession(sessionId: string): WebSocketSession {
    const exactSessionId = requireExactDurableIdentifier(
      sessionId,
      "Codex WebSocket sessionId"
    )
    const existing = this.sessions.get(exactSessionId)
    if (existing) return existing

    const session: WebSocketSession = {
      sessionId: exactSessionId,
      conn: null,
      wsUrl: "",
      requestTail: Promise.resolve(),
      readerConn: null,
      activeStream: null,
    }
    this.sessions.set(exactSessionId, session)
    return session
  }

  async acquireSession(
    sessionId: string
  ): Promise<{ session: WebSocketSession; release: () => void }> {
    const session = this.getOrCreateSession(sessionId)
    const previous = session.requestTail.catch(() => undefined)
    let resolveCurrent: (() => void) | null = null
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })
    session.requestTail = previous.then(() => current)
    await previous

    let released = false
    return {
      session,
      release: () => {
        if (released) {
          return
        }
        released = true
        resolveCurrent?.()
        if (session.requestTail === current) {
          session.requestTail = Promise.resolve()
        }
      },
    }
  }

  async ensureSessionConnection(
    sessionId: string,
    wsUrl: string,
    headers: Record<string, string>,
    proxyUrl?: string
  ): Promise<WebSocket> {
    const session = this.getOrCreateSession(sessionId)
    const current = session.conn

    if (
      current &&
      current.readyState === WebSocket.OPEN &&
      session.wsUrl === wsUrl
    ) {
      return current
    }

    this.invalidateSessionConnection(
      session.sessionId,
      current,
      current
        ? current.readyState === WebSocket.OPEN
          ? "replace_ws_url_changed"
          : `replace_${this.describeReadyState(current.readyState)}_connection`
        : "open_initial_connection"
    )

    const ws = await this.connect(wsUrl, headers, proxyUrl)
    session.conn = ws
    session.wsUrl = wsUrl
    this.attachSessionLifecycle(session, ws)
    return ws
  }

  hasOpenSessionConnection(sessionId: string, wsUrl?: string): boolean {
    const exactSessionId = requireExactDurableIdentifier(
      sessionId,
      "Codex WebSocket sessionId"
    )
    const session = this.sessions.get(exactSessionId)
    if (!session?.conn || session.conn.readyState !== WebSocket.OPEN) {
      return false
    }

    if (wsUrl && session.wsUrl !== wsUrl) {
      return false
    }

    return true
  }

  invalidateSessionConnection(
    sessionId: string,
    conn?: WebSocket | null,
    reason: string = "invalidate_session_connection"
  ): void {
    const exactSessionId = requireExactDurableIdentifier(
      sessionId,
      "Codex WebSocket sessionId"
    )
    const session = this.sessions.get(exactSessionId)
    if (!session) {
      return
    }

    const current = session.conn
    if (!current) {
      session.wsUrl = ""
      return
    }

    if (conn && current !== conn) {
      return
    }

    this.connCloseOrigins.set(current, reason)
    this.logger.debug(
      `[Codex][WS] invalidating session=${sessionId} reason=${reason} readyState=${this.describeReadyState(current.readyState)}`
    )
    this.failActiveStream(
      session,
      current,
      // An abort is something the bridge asked for — a cancelled or superseded
      // turn taking its stream down — so the failure it produces is not the
      // provider's. Reported as one, it reached the transcript as a model
      // error for a turn the bridge went on to recover by itself.
      reason === "abort_signal"
        ? new UpstreamRequestAbortedError(
            "WebSocket session aborted before response.completed"
          )
        : new Error("WebSocket session invalidated before response.completed")
    )
    session.conn = null
    session.wsUrl = ""
    session.readerConn = null
    try {
      current.close()
    } catch (e) {
      this.logger.warn(
        `Error closing WebSocket session ${sessionId}: ${(e as Error).message}`
      )
    }
  }

  private attachSessionLifecycle(
    session: WebSocketSession,
    conn: WebSocket
  ): void {
    if (session.readerConn === conn) {
      return
    }

    session.readerConn = conn
    this.connToSession.set(conn, session)

    const clearIfCurrent = () => {
      if (session.conn === conn) {
        session.conn = null
        session.wsUrl = ""
      }
      if (session.readerConn === conn) {
        session.readerConn = null
      }
    }

    conn.on("message", (data) => {
      const activeStream = session.activeStream
      if (!activeStream || activeStream.conn !== conn) {
        return
      }

      activeStream.queue.push({ data })
      activeStream.waiter?.()
      activeStream.waiter = null
    })

    conn.on("close", (code: number, reason: Buffer) => {
      const reasonText = reason.toString("utf8")
      const activeStream = session.activeStream
      const closeOrigin =
        this.connCloseOrigins.get(conn) || "remote_or_transport"
      this.connCloseOrigins.delete(conn)
      this.logger.debug(
        `WebSocket session ${session.sessionId} closed: code=${code} reason=${JSON.stringify(reasonText)} active=${activeStream?.conn === conn} origin=${closeOrigin} readyState=${this.describeReadyState(conn.readyState)}`
      )
      this.failActiveStream(
        session,
        conn,
        new Error("WebSocket closed before response.completed")
      )
      clearIfCurrent()
    })

    conn.on("error", (error) => {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error))
      this.logger.debug(
        `WebSocket session ${session.sessionId} error: ${normalizedError.message}`
      )
      this.failActiveStream(session, conn, normalizedError)
      clearIfCurrent()
    })
  }

  private failActiveStream(
    session: WebSocketSession,
    conn: WebSocket | null,
    error: Error
  ): void {
    if (!conn) {
      return
    }

    const activeStream = session.activeStream
    if (!activeStream || activeStream.conn !== conn) {
      return
    }

    activeStream.done = true
    activeStream.queue.push({ error })
    activeStream.waiter?.()
    activeStream.waiter = null
    session.activeStream = null
  }

  private normalizeIncomingMessage(data: WebSocket.Data): string {
    if (typeof data === "string") {
      return data.trim()
    }

    if (Array.isArray(data)) {
      return Buffer.concat(
        data.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))
      )
        .toString("utf-8")
        .trim()
    }

    return Buffer.isBuffer(data)
      ? data.toString("utf-8").trim()
      : Buffer.from(data).toString("utf-8").trim()
  }

  private parseWebSocketMessage(
    data: WebSocket.Data
  ): WebSocketMessage | undefined {
    const raw = this.normalizeIncomingMessage(data)
    if (!raw) {
      return undefined
    }

    const parsed = JSON.parse(raw) as WebSocketMessage
    if (parsed.type === "error") {
      const status =
        (parsed.status as number) || (parsed.status_code as number) || 500
      const errorBody = JSON.stringify(parsed)
      // 协议级逻辑错误：previous_response_id 失效。TCP/WS 帧通道仍健康，
      // 标记 preserveConnection=true 让上层在保留 ws 的前提下重发完整 input。
      const preserveConnection =
        status === 400 && /previous.response.*not found/i.test(errorBody)
      throw new CodexWebSocketUpgradeError(status, errorBody, {
        preserveConnection,
      })
    }

    readCodexResponseOutcome(parsed, { allowMaxOutputIncomplete: true })

    return parsed
  }

  private async waitForSessionQueue(
    activeStream: SessionActiveStream
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        if (activeStream.waiter === finish) {
          activeStream.waiter = null
        }
        resolve()
      }
      const timeoutId = setTimeout(() => {
        activeStream.done = true
        activeStream.queue.push({
          error: new Error("Codex WebSocket idle timeout"),
        })
        finish()
      }, WS_IDLE_TIMEOUT_MS)
      activeStream.waiter = finish
    })
  }

  private async sendRequestPayload(
    ws: WebSocket,
    requestBody: Record<string, unknown>
  ): Promise<void> {
    const payload = JSON.stringify(requestBody)
    await new Promise<void>((resolve, reject) => {
      ws.send(payload, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private async *streamViaSessionWebSocket(
    session: WebSocketSession,
    ws: WebSocket,
    requestBody: Record<string, unknown>
  ): AsyncGenerator<WebSocketMessage, void, unknown> {
    if (session.activeStream) {
      throw new Error(
        `WebSocket session ${session.sessionId} already has an active request`
      )
    }

    const activeStream: SessionActiveStream = {
      conn: ws,
      queue: [],
      waiter: null,
      done: false,
    }
    session.activeStream = activeStream
    let responseCompleted = false
    let preserveOnError = false

    try {
      await this.sendRequestPayload(ws, requestBody)

      while (!activeStream.done || activeStream.queue.length > 0) {
        if (activeStream.queue.length === 0) {
          await this.waitForSessionQueue(activeStream)
          continue
        }

        const item = activeStream.queue.shift()
        if (!item) {
          continue
        }
        if (item.error) {
          throw item.error
        }
        if (!item.data) {
          continue
        }

        let parsed: WebSocketMessage | undefined
        try {
          parsed = this.parseWebSocketMessage(item.data)
        } catch (error) {
          if (
            error instanceof CodexWebSocketUpgradeError &&
            error.preserveConnection &&
            ws.readyState === WebSocket.OPEN
          ) {
            preserveOnError = true
          }
          if (session.activeStream === activeStream) {
            session.activeStream = null
          }
          throw error
        }
        if (!parsed) {
          continue
        }

        if (
          parsed.type === "response.completed" ||
          parsed.type === "response.incomplete"
        ) {
          // Only completed responses can retain a reusable continuation baseline.
          responseCompleted = parsed.type === "response.completed"
          activeStream.done = true
          yield parsed
          return
        }
        yield parsed
      }
    } finally {
      if (session.activeStream === activeStream) {
        session.activeStream = null
      }
      if (!responseCompleted && !preserveOnError) {
        this.invalidateSessionConnection(
          session.sessionId,
          ws,
          "stream_ended_before_response_completed"
        )
      } else if (preserveOnError) {
        this.logger.debug(
          `[Codex][WS] session ${session.sessionId} preserved after protocol-level error (ws.readyState=${ws.readyState})`
        )
      }
    }
  }

  private async *streamViaStandaloneWebSocket(
    ws: WebSocket,
    requestBody: Record<string, unknown>
  ): AsyncGenerator<WebSocketMessage, void, unknown> {
    const messageQueue: SessionStreamQueueItem[] = []
    let resolveWaiter: (() => void) | null = null
    let done = false

    const enqueue = (item: SessionStreamQueueItem) => {
      messageQueue.push(item)
      resolveWaiter?.()
      resolveWaiter = null
    }

    const onMessage = (data: WebSocket.Data) => {
      enqueue({ data })
    }

    const onError = (err: Error) => {
      done = true
      enqueue({ error: err })
    }

    const onClose = () => {
      if (!done) {
        done = true
        enqueue({
          error: new Error("WebSocket closed before response.completed"),
        })
      }
    }

    ws.on("message", onMessage)
    ws.on("error", onError)
    ws.on("close", onClose)

    try {
      await this.sendRequestPayload(ws, requestBody)

      while (!done || messageQueue.length > 0) {
        if (messageQueue.length === 0) {
          await new Promise<void>((resolve) => {
            let settled = false
            const finish = () => {
              if (settled) {
                return
              }
              settled = true
              clearTimeout(timeoutId)
              if (resolveWaiter === finish) {
                resolveWaiter = null
              }
              resolve()
            }
            const timeoutId = setTimeout(() => {
              done = true
              messageQueue.push({
                error: new Error("Codex WebSocket idle timeout"),
              })
              finish()
            }, WS_IDLE_TIMEOUT_MS)
            resolveWaiter = finish
          })
          continue
        }

        const item = messageQueue.shift()
        if (!item) {
          continue
        }
        if (item.error) {
          throw item.error
        }
        if (!item.data) {
          continue
        }

        let parsed: WebSocketMessage | undefined
        try {
          parsed = this.parseWebSocketMessage(item.data)
        } catch (error) {
          done = true
          throw error
        }
        if (!parsed) {
          continue
        }

        if (
          parsed.type === "response.completed" ||
          parsed.type === "response.incomplete"
        ) {
          done = true
          yield parsed
          return
        }
        yield parsed
      }
    } finally {
      ws.off("message", onMessage)
      ws.off("error", onError)
      ws.off("close", onClose)
    }
  }

  /**
   * Close a session and its WebSocket connection.
   */
  closeSession(sessionId: string, reason: string = "close_session"): void {
    const exactSessionId = requireExactDurableIdentifier(
      sessionId,
      "Codex WebSocket sessionId"
    )
    const session = this.sessions.get(exactSessionId)
    if (!session) return

    this.invalidateSessionConnection(exactSessionId, session.conn, reason)
    this.sessions.delete(exactSessionId)
    this.logger.log(
      `WebSocket session closed: ${exactSessionId} reason=${reason}`
    )
  }

  /**
   * Check if WebSocket transport is available.
   * Returns true since the ws module is a static dependency.
   */
  isWebSocketAvailable(): boolean {
    return typeof WebSocket !== "undefined"
  }

  private describeReadyState(readyState: number): string {
    switch (readyState) {
      case WebSocket.CONNECTING:
        return "connecting"
      case WebSocket.OPEN:
        return "open"
      case WebSocket.CLOSING:
        return "closing"
      case WebSocket.CLOSED:
        return "closed"
      default:
        return String(readyState)
    }
  }
}

// ── Error Types ────────────────────────────────────────────────────────

export class CodexWebSocketUpgradeError extends Error {
  /**
   * 当为 true 时，错误属于"协议级逻辑错误"——TCP/WS 帧通道仍然健康，
   * 上层 catch 后可以直接复用同一 WebSocket 重发请求，避免一次完整握手。
   * 当前唯一会标记的场景：服务器拒绝 previous_response_id（HTTP 400 +
   * "Previous response with id ... not found"）。
   */
  public readonly preserveConnection: boolean

  constructor(
    public readonly statusCode: number,
    public readonly body: string,
    options: { preserveConnection?: boolean } = {}
  ) {
    super(
      `WebSocket upgrade failed: status=${statusCode}, body=${body.slice(0, 200)}`
    )
    this.name = "CodexWebSocketUpgradeError"
    this.preserveConnection = options.preserveConnection === true
  }

  /**
   * Check if this error indicates the server doesn't support WebSocket
   * and we should fall back to HTTP.
   */
  shouldFallbackToHttp(): boolean {
    // 只在 426 Upgrade Required 时降级到 HTTP。
    // 401 Unauthorized 不应 fallback——由 codex.service.ts 的 tryRefreshSlotToken()
    // 执行 token 刷新后重建 WebSocket 连接，以保留 prompt cache 优势。
    return this.statusCode === 426
  }
}
