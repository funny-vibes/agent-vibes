import { Logger } from "@nestjs/common"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

/**
 * HTTP forward proxy used to redirect Cursor agent traffic from a remote
 * SSH workspace to the locally-running bridge — without requiring root
 * access on the remote host.
 *
 * Typical setup:
 *   1. Bridge starts the proxy on `127.0.0.1:18080` (loopback only).
 *   2. User opens an SSH reverse tunnel:
 *        ssh -R 18080:127.0.0.1:18080 user@remote
 *      so the remote host can reach the bridge proxy at its own
 *      `127.0.0.1:18080`.
 *   3. On the remote host, the user exports
 *        export HTTPS_PROXY=http://127.0.0.1:18080
 *      before launching the Cursor server / agent runtime.
 *
 * The proxy implements only the parts of HTTP/1.1 needed for HTTPS
 * traffic via the CONNECT method:
 *   - For Cursor agent/auth domains (api2.cursor.sh, api5.cursor.sh, …),
 *     the connection is spliced to the bridge's loopback HTTPS port so
 *     the existing TLS certificate chain handles the request.
 *   - For any other domain, the connection is spliced through to the
 *     real upstream, so the proxy stays a drop-in HTTPS_PROXY for the
 *     remote shell.
 *
 * Security notes:
 *   - The proxy binds only to `127.0.0.1`. Remote access is mediated by
 *     SSH reverse forwarding, which already requires SSH auth.
 *   - No outbound DNS/network is performed on behalf of arbitrary
 *     hostnames until the client issues a CONNECT — a malicious local
 *     process could already reach those hosts directly.
 */

const BRIDGE_HOST = "127.0.0.1"

const CURSOR_BRIDGE_HOSTS: ReadonlyArray<string> = [
  "api2.cursor.sh",
  "api2geo.cursor.sh",
  "api2direct.cursor.sh",
  "api3.cursor.sh",
  "api4.cursor.sh",
  "api5.cursor.sh",
  "api5geo.cursor.sh",
  "api5lat.cursor.sh",
  "authentication.cursor.sh",
  "authenticator.cursor.sh",
  "prod.authentication.cursor.sh",
  "repo42.cursor.sh",
]

const CURSOR_BRIDGE_HOST_SUFFIXES: ReadonlyArray<string> =
  CURSOR_BRIDGE_HOSTS.map((host) => `.${host}`)

interface ConnectRequest {
  host: string
  port: number
  rawHeaderEnd: number
}

export interface ForwardProxyOptions {
  /** Listening port for the proxy (defaults to 18080). */
  port?: number
  /** Local bridge port that will receive Cursor traffic. */
  bridgePort: number
  /** Host the proxy binds to. Defaults to loopback for safety. */
  bindHost?: string
  /** Maximum bytes to buffer while parsing the CONNECT request line. */
  maxRequestLineBytes?: number
  /** Idle timeout for the initial CONNECT handshake (ms). */
  handshakeTimeoutMs?: number
  /** JSONL trace file for proxy routing diagnostics. */
  traceFile?: string
}

/**
 * Returns true when the given host should be redirected to the local
 * bridge. Hostnames are compared case-insensitively against the known
 * Cursor agent FQDNs and the `agent.` / `agentn.` style subdomains used
 * by Cursor IDE.
 */
export function isCursorAgentHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (!normalized) return false
  if (CURSOR_BRIDGE_HOSTS.includes(normalized)) return true
  return CURSOR_BRIDGE_HOST_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix)
  )
}

/**
 * Parses an HTTP/1.1 CONNECT request line from the incoming buffer.
 * Returns `null` if the buffer does not yet contain the full header
 * block. Throws if the request is invalid (so we can return a clean
 * `400 Bad Request`).
 */
function parseConnect(buffer: Buffer): ConnectRequest | null {
  const headerEnd = buffer.indexOf("\r\n\r\n")
  if (headerEnd === -1) {
    return null
  }
  const head = buffer.slice(0, headerEnd).toString("utf8")
  const requestLine = head.split("\r\n", 1)[0] ?? ""
  if (!requestLine) {
    throw new Error("missing request line")
  }
  const parts = requestLine.split(" ")
  if (parts.length < 3) {
    throw new Error("malformed request line")
  }
  const method = parts[0] ?? ""
  const target = parts[1] ?? ""
  if (!method || !target) {
    throw new Error("malformed request line")
  }
  if (method.toUpperCase() !== "CONNECT") {
    throw new Error(`unsupported method: ${method}`)
  }
  const lastColon = target.lastIndexOf(":")
  if (lastColon <= 0 || lastColon === target.length - 1) {
    throw new Error(`invalid CONNECT target: ${target}`)
  }
  const host = target.slice(0, lastColon)
  const portText = target.slice(lastColon + 1)
  const port = Number.parseInt(portText, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid CONNECT port: ${portText}`)
  }
  return { host, port, rawHeaderEnd: headerEnd + 4 }
}

function writeResponse(
  socket: net.Socket,
  status: number,
  reason: string,
  body?: string
): void {
  if (socket.destroyed) return
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Length: " + (body ? Buffer.byteLength(body, "utf8") : 0),
    "",
    body ?? "",
  ]
  socket.end(lines.join("\r\n"))
}

/**
 * Splice two sockets so any data written to one is forwarded to the
 * other. Both sockets are destroyed when either side closes or errors.
 */
function pipeSockets(a: net.Socket, b: net.Socket): void {
  const teardown = (cause?: Error): void => {
    if (cause) {
      // Best-effort cleanup; do not log noisy ECONNRESET on closed peers.
      a.destroy()
      b.destroy()
      return
    }
    a.end()
    b.end()
  }

  a.on("error", teardown)
  b.on("error", teardown)
  a.on("close", () => b.destroy())
  b.on("close", () => a.destroy())
  a.pipe(b)
  b.pipe(a)
}

export class ForwardProxyServer {
  private readonly logger = new Logger(ForwardProxyServer.name)
  private readonly server: net.Server
  private readonly options: Required<ForwardProxyOptions>
  private readonly traceFile: string

  constructor(options: ForwardProxyOptions) {
    const defaultLogDir =
      process.env.AGENT_VIBES_LOG_DIR ||
      path.join(os.tmpdir(), "agent-vibes-logs")

    this.options = {
      port: options.port ?? 18080,
      bridgePort: options.bridgePort,
      bindHost: options.bindHost ?? "127.0.0.1",
      maxRequestLineBytes: options.maxRequestLineBytes ?? 16 * 1024,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 15_000,
      traceFile:
        options.traceFile ||
        process.env.FORWARD_PROXY_TRACE_FILE ||
        path.join(defaultLogDir, "forward_proxy_trace.jsonl"),
    }
    this.traceFile = this.options.traceFile

    this.server = net.createServer((socket) => this.handleConnection(socket))
    this.server.on("error", (err) => {
      this.logger.error(
        `Forward proxy server error: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  private appendTrace(event: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.traceFile), { recursive: true })
      fs.appendFileSync(
        this.traceFile,
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
        "utf8"
      )
    } catch {
      // Trace logging must never break proxy traffic.
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListen)
        reject(err)
      }
      const onListen = () => {
        this.server.off("error", onError)
        resolve()
      }
      this.server.once("error", onError)
      this.server.once("listening", onListen)
      this.server.listen(this.options.port, this.options.bindHost)
    })

    const address = this.server.address()
    if (address && typeof address === "object") {
      this.logger.log(
        `Forward proxy listening on ${this.options.bindHost}:${address.port} → bridge ${BRIDGE_HOST}:${this.options.bridgePort}`
      )
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  private handleConnection(socket: net.Socket): void {
    let buffered = Buffer.alloc(0)
    let handled = false

    const handshakeTimer = setTimeout(() => {
      if (!handled) {
        writeResponse(socket, 408, "Request Timeout")
      }
    }, this.options.handshakeTimeoutMs)

    const cleanup = (): void => {
      clearTimeout(handshakeTimer)
      socket.removeAllListeners("data")
    }

    socket.on("error", () => {
      cleanup()
      socket.destroy()
    })

    socket.on("data", (chunk: Buffer) => {
      if (handled) return
      buffered = Buffer.concat([buffered, chunk])

      if (buffered.length > this.options.maxRequestLineBytes) {
        handled = true
        cleanup()
        writeResponse(socket, 413, "Payload Too Large")
        return
      }

      let parsed: ConnectRequest | null
      try {
        parsed = parseConnect(buffered)
      } catch (err) {
        handled = true
        cleanup()
        writeResponse(
          socket,
          400,
          "Bad Request",
          err instanceof Error ? err.message : String(err)
        )
        return
      }
      if (!parsed) {
        return
      }

      handled = true
      cleanup()

      const remainder = buffered.slice(parsed.rawHeaderEnd)
      this.dispatch(socket, parsed, remainder)
    })
  }

  private dispatch(
    clientSocket: net.Socket,
    request: ConnectRequest,
    leftover: Buffer
  ): void {
    const targetIsCursor = isCursorAgentHost(request.host)
    const upstreamHost = targetIsCursor ? BRIDGE_HOST : request.host
    const upstreamPort = targetIsCursor ? this.options.bridgePort : request.port

    const routeMessage =
      `CONNECT ${request.host}:${request.port} -> ${upstreamHost}:${upstreamPort}` +
      (targetIsCursor ? " (cursor splice)" : "")
    this.appendTrace({
      event: "connect",
      host: request.host,
      port: request.port,
      upstreamHost,
      upstreamPort,
      cursorSplice: targetIsCursor,
      clientAddress: clientSocket.remoteAddress,
    })
    if (targetIsCursor) {
      this.logger.warn(routeMessage)
    } else {
      this.logger.debug(routeMessage)
    }

    const upstream = net.createConnection(
      { host: upstreamHost, port: upstreamPort },
      () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (leftover.length > 0) {
          upstream.write(leftover)
        }
        pipeSockets(clientSocket, upstream)
      }
    )

    upstream.on("error", (err) => {
      this.logger.warn(
        `Forward proxy upstream error (${upstreamHost}:${upstreamPort}): ${err.message}`
      )
      writeResponse(clientSocket, 502, "Bad Gateway", err.message)
      upstream.destroy()
    })
  }
}
