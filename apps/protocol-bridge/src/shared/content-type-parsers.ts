import { Logger } from "@nestjs/common"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Readable } from "stream"
import * as zlib from "zlib"

/**
 * Register custom content type parsers for gRPC/ConnectRPC.
 * Must be called BEFORE NestFactory.create() to avoid conflicts with NestJS default parsers.
 */
export function registerContentTypeParsers(
  fastify: FastifyInstance,
  logger: Logger
): void {
  // application/connect+proto — bidirectional streaming (HTTP/2)
  fastify.addContentTypeParser(
    "application/connect+proto",
    { bodyLimit: 52428800 },
    (
      request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      logger.debug("[ContentTypeParser] Handling application/connect+proto")
      logger.debug(
        `[ContentTypeParser] HTTP version: ${request.raw.httpVersion}, readable: ${payload.readable}`
      )

      // Check if payload is already a buffer
      if (Buffer.isBuffer(payload)) {
        logger.debug(
          `[ContentTypeParser] application/connect+proto: received ${payload.length} bytes (buffer)`
        )
        done(null, payload)
        return
      }

      // For BiDi streams, we process the first chunk immediately
      // because the client keeps the stream open for tool results
      let firstChunkReceived = false
      let doneCalled = false
      const chunks: Buffer[] = []
      let firstChunkTimer: NodeJS.Timeout | null = null
      let emptyBodyTimer: NodeJS.Timeout | null = null
      let onData: (chunk: Buffer) => void = () => undefined
      let onEnd: () => void = () => undefined
      let onError: (err: Error) => void = () => undefined

      const cleanup = () => {
        if (firstChunkTimer) {
          clearTimeout(firstChunkTimer)
          firstChunkTimer = null
        }
        if (emptyBodyTimer) {
          clearTimeout(emptyBodyTimer)
          emptyBodyTimer = null
        }
        payload.off("data", onData)
        payload.off("end", onEnd)
        payload.off("error", onError)
      }

      const finalize = (source: string) => {
        if (doneCalled) return
        doneCalled = true
        cleanup()
        const buffer = Buffer.concat(chunks)
        logger.debug(
          `[ContentTypeParser] application/connect+proto: received ${buffer.length} bytes (${source})`
        )
        done(null, buffer)
      }

      onData = (chunk: Buffer) => {
        if (doneCalled) {
          return
        }

        logger.debug(
          `[ContentTypeParser] Received chunk: ${chunk.length} bytes`
        )
        chunks.push(chunk)

        // For BiDi streams, process immediately after first chunk
        // HTTP/2 BiDi streams don't emit 'end' until client closes
        if (!firstChunkReceived) {
          firstChunkReceived = true
          // Wait a bit longer to allow more data to arrive
          firstChunkTimer = setTimeout(() => {
            if (chunks.length > 0 && !doneCalled) {
              finalize("BiDi first chunk")
            }
          }, 50)
        }
      }

      onEnd = () => {
        // This may not fire for BiDi streams
        logger.debug(
          `[ContentTypeParser] application/connect+proto: stream end event, firstChunkReceived=${firstChunkReceived}, chunks=${chunks.length}`
        )
        if (!doneCalled) {
          // Wait a short time for any pending data
          firstChunkTimer = setTimeout(() => {
            finalize("stream end")
          }, 10)
        }
      }

      onError = (err: Error) => {
        cleanup()
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          logger.debug(`[ContentTypeParser] Stream closed (normal disconnect)`)
        } else {
          logger.error(
            `[ContentTypeParser] Error reading stream: ${err.message}`
          )
        }
        if (!doneCalled) {
          doneCalled = true
          done(err)
        }
      }

      payload.on("data", onData)
      payload.on("end", onEnd)
      payload.on("error", onError)

      // For HTTP/2, also set a timeout to handle cases where no data arrives
      emptyBodyTimer = setTimeout(() => {
        if (!doneCalled && chunks.length === 0) {
          logger.warn(
            "[ContentTypeParser] application/connect+proto: timeout with no data, returning empty buffer"
          )
          finalize("timeout")
        }
      }, 100)
    }
  )

  // application/proto — standard unary protobuf
  fastify.addContentTypeParser(
    "application/proto",
    { bodyLimit: 52428800 },
    (
      request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      const shouldLogProtoTraffic = process.env.LOG_PROTO_TRAFFIC === "true"
      if (shouldLogProtoTraffic) {
        logger.debug("[ContentTypeParser] Handling application/proto")
      }

      // ConnectRPC uses Connect-Content-Encoding for compressed payloads
      const encoding =
        (request.headers["connect-content-encoding"] as string) ||
        (request.headers["content-encoding"] as string) ||
        ""

      const chunks: Buffer[] = []
      payload.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      payload.on("end", () => {
        const buffer = Buffer.concat(chunks)
        if (shouldLogProtoTraffic) {
          logger.debug(
            `[ContentTypeParser] application/proto: received ${buffer.length} bytes` +
              (encoding ? `, encoding=${encoding}` : "")
          )
        }

        // Decompress gzip if needed
        if (encoding.toLowerCase() === "gzip" && buffer.length > 0) {
          zlib.gunzip(buffer, (err, decompressed) => {
            if (err) {
              logger.error(
                `[ContentTypeParser] gzip decompression failed: ${err.message}`
              )
              // Fall back to raw buffer in case encoding header was wrong
              done(null, buffer)
            } else {
              if (shouldLogProtoTraffic) {
                logger.debug(
                  `[ContentTypeParser] application/proto: decompressed ${buffer.length} -> ${decompressed.length} bytes`
                )
              }
              done(null, decompressed)
            }
          })
        } else {
          done(null, buffer)
        }
      })
      payload.on("error", (err: Error) => {
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          logger.debug(`[ContentTypeParser] Stream closed (normal disconnect)`)
        } else {
          logger.error(
            `[ContentTypeParser] Error reading stream: ${err.message}`
          )
        }
        done(err)
      })
    }
  )

  // application/x-protobuf — OTLP traces exporter (OpenTelemetry)
  fastify.addContentTypeParser(
    "application/x-protobuf",
    { bodyLimit: 52428800 },
    (
      _request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      const chunks: Buffer[] = []
      payload.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      payload.on("end", () => {
        done(null, Buffer.concat(chunks))
      })
      payload.on("error", (err: Error) => {
        done(err)
      })
    }
  )
}
