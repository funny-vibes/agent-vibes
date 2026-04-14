/**
 * Codex WebSocket Transport Service
 *
 * Implements WebSocket-based transport for the Codex Responses API.
 * Supports:
 * - WebSocket connection management with session reuse
 * - Automatic reconnection on connection loss
 * - Fallback to HTTP when WebSocket upgrade is rejected
 * - Prompt cache via WebSocket headers
 * - Streaming and non-streaming modes
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_websockets_executor.go
 *
 * Protocol:
 *   The Codex WebSocket API uses the "responses_websockets=2026-02-06" beta.
 *   Each request is sent as a JSON message with type "response.create".
 *   Responses are received as individual JSON messages (not SSE-wrapped).
 *   The response.completed/response.done event signals end of response.
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import WebSocket from "ws"
import {
  buildCodexWebSocketHeaders,
  type CodexForwardHeaders,
} from "./codex-header-utils"

// ── Constants ──────────────────────────────────────────────────────────

const WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const WS_HANDSHAKE_TIMEOUT_MS = 30 * 1000 // 30 seconds

// ── Types ──────────────────────────────────────────────────────────────

export interface WebSocketSession {
  sessionId: string
  conn: WebSocket | null
  wsUrl: string
  requestTail: Promise<void>
}

export interface WebSocketMessage {
  type: string
  [key: string]: unknown
}

export interface CodexWebSocketError {
  status: number
  error: Record<string, unknown>
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexWebSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(CodexWebSocketService.name)

  /** Active sessions keyed by session ID */
  private readonly sessions = new Map<string, WebSocketSession>()

  constructor() {}

  onModuleDestroy(): void {
    // Close all active sessions
    for (const [id] of this.sessions) {
      this.closeSession(id)
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

  /**
   * Build WebSocket connection headers.
   * Ported from: codex_websockets_executor.go applyCodexWebsocketHeaders()
   */
  buildWebSocketHeaders(
    token: string,
    isApiKey: boolean,
    accountId?: string,
    workspaceId?: string,
    cacheHeaders?: Record<string, string>,
    forwardHeaders?: CodexForwardHeaders,
    omitAccountId: boolean = false
  ): Record<string, string> {
    return buildCodexWebSocketHeaders({
      token,
      isApiKey,
      accountId,
      workspaceId,
      cacheHeaders,
      forwardHeaders,
      omitAccountId,
    })
  }

  private buildProxyAgent(
    wsUrl: string,
    proxyUrl?: string
  ):
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    if (!proxyUrl) return undefined

    const normalizedProxyUrl = proxyUrl.trim()
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

  // ── Request Body Building ──────────────────────────────────────────

  /**
   * Wrap a Codex request body for WebSocket transport.
   * Ported from: codex_websockets_executor.go buildCodexWebsocketRequestBody()
   */
  buildWebSocketRequestBody(
    body: Record<string, unknown>
  ): Record<string, unknown> {
    return { ...body, type: "response.create" }
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
    // Send the request
    const payload = JSON.stringify(requestBody)
    ws.send(payload)

    // Create a message queue
    const messageQueue: Array<{
      data: WebSocketMessage | null
      error: Error | null
    }> = []
    let resolveWaiter: (() => void) | null = null
    let done = false

    const enqueue = (item: {
      data: WebSocketMessage | null
      error: Error | null
    }) => {
      messageQueue.push(item)
      if (resolveWaiter) {
        resolveWaiter()
        resolveWaiter = null
      }
    }

    const onMessage = (data: WebSocket.Data) => {
      try {
        const raw = (
          typeof data === "string"
            ? data
            : Buffer.from(data as ArrayBuffer).toString("utf-8")
        ).trim()
        if (!raw) return

        const parsed = JSON.parse(raw) as WebSocketMessage

        // Check for WebSocket-level errors
        if (parsed.type === "error") {
          const status =
            (parsed.status as number) || (parsed.status_code as number) || 500
          enqueue({
            data: null,
            error: new CodexWebSocketUpgradeError(
              status,
              JSON.stringify(parsed.error || parsed)
            ),
          })
          return
        }

        // Normalize response.done → response.completed
        if (parsed.type === "response.done") {
          parsed.type = "response.completed"
        }

        enqueue({ data: parsed, error: null })

        // End of response
        if (parsed.type === "response.completed") {
          done = true
        }
      } catch (e) {
        this.logger.warn(
          `Failed to parse WebSocket message: ${(e as Error).message}`
        )
      }
    }

    const onError = (err: Error) => {
      enqueue({ data: null, error: err })
      done = true
    }

    const onClose = () => {
      if (!done) {
        enqueue({
          data: null,
          error: new Error("WebSocket closed before response.completed"),
        })
      }
      done = true
    }

    ws.on("message", onMessage)
    ws.on("error", onError)
    ws.on("close", onClose)

    try {
      while (!done || messageQueue.length > 0) {
        if (messageQueue.length === 0) {
          // Wait for next message
          await new Promise<void>((resolve) => {
            resolveWaiter = resolve
            // Safety timeout
            setTimeout(resolve, WS_IDLE_TIMEOUT_MS)
          })
          continue
        }

        const item = messageQueue.shift()!
        if (item.error) {
          throw item.error
        }
        if (item.data) {
          yield item.data

          if (item.data.type === "response.completed") {
            return
          }
        }
      }
    } finally {
      ws.off("message", onMessage)
      ws.off("error", onError)
      ws.off("close", onClose)
    }
  }

  // ── Non-streaming via WebSocket ────────────────────────────────────

  /**
   * Send a request via WebSocket and collect the full response.
   * Returns the response.completed event data.
   */
  async sendViaWebSocket(
    ws: WebSocket,
    requestBody: Record<string, unknown>
  ): Promise<WebSocketMessage> {
    for await (const msg of this.streamViaWebSocket(ws, requestBody)) {
      if (msg.type === "response.completed") {
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
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session: WebSocketSession = {
      sessionId,
      conn: null,
      wsUrl: "",
      requestTail: Promise.resolve(),
    }
    this.sessions.set(sessionId, session)
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

    this.invalidateSessionConnection(sessionId, current)

    const ws = await this.connect(wsUrl, headers, proxyUrl)
    session.conn = ws
    session.wsUrl = wsUrl
    this.attachSessionLifecycle(session, ws)
    return ws
  }

  invalidateSessionConnection(
    sessionId: string,
    conn?: WebSocket | null
  ): void {
    const session = this.sessions.get(sessionId)
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

    session.conn = null
    session.wsUrl = ""
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
    const clearIfCurrent = () => {
      if (session.conn === conn) {
        session.conn = null
        session.wsUrl = ""
      }
    }

    conn.on("close", clearIfCurrent)
    conn.on("error", clearIfCurrent)
  }

  /**
   * Close a session and its WebSocket connection.
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.invalidateSessionConnection(sessionId, session.conn)
    this.sessions.delete(sessionId)
    this.logger.log(`WebSocket session closed: ${sessionId}`)
  }

  /**
   * Close all sessions.
   */
  closeAllSessions(): void {
    for (const [id] of this.sessions) {
      this.closeSession(id)
    }
  }

  /**
   * Check if WebSocket transport is available.
   * Returns true since the ws module is a static dependency.
   */
  isWebSocketAvailable(): boolean {
    return typeof WebSocket !== "undefined"
  }
}

// ── Error Types ────────────────────────────────────────────────────────

export class CodexWebSocketUpgradeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string
  ) {
    super(
      `WebSocket upgrade failed: status=${statusCode}, body=${body.slice(0, 200)}`
    )
    this.name = "CodexWebSocketUpgradeError"
  }

  /**
   * Check if this error indicates the server doesn't support WebSocket
   * and we should fall back to HTTP.
   */
  shouldFallbackToHttp(): boolean {
    return this.statusCode === 426 // 426 Upgrade Required
  }
}
