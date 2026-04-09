import { Logger } from "@nestjs/common"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import * as fs from "fs"

/**
 * Register request logging hooks for debugging.
 * Logs proto/gRPC requests and optionally dumps raw buffers.
 */
export function registerRequestHooks(
  fastify: FastifyInstance,
  logger: Logger
): void {
  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const url = request.url || ""
      const ct = request.headers["content-type"] || ""

      if (process.env.LOG_PROTO_TRAFFIC === "true") {
        // Very noisy Cursor dashboard/analytics polling diagnostics. Keep this
        // behind an explicit flag instead of LOG_DEBUG.
        if (ct.includes("proto") || ct.includes("connect")) {
          const rawEncoding =
            request.headers["connect-content-encoding"] ||
            request.headers["content-encoding"] ||
            ""
          const encoding = Array.isArray(rawEncoding)
            ? rawEncoding[0]
            : rawEncoding
          logger.debug(
            `[ALL-PROTO] ${request.method} ${url} - Content-Type: ${ct}` +
              (encoding ? `, Encoding: ${encoding}` : "")
          )
        }
      }

      // Log Cursor gRPC requests (agent only)
      if (url.includes("agent.v1")) {
        logger.debug(
          `[Cursor gRPC] ${request.method} ${url} - Content-Type: ${request.headers["content-type"]}`
        )

        // Dump raw buffer for debugging (if enabled)
        if (process.env.LOG_DEBUG === "true" && request.body) {
          const timestamp = Date.now()
          const safePath = url.replace(/[^a-zA-Z0-9]/g, "_")
          const filename = `/tmp/cursor_req_${timestamp}_${safePath}.bin`

          try {
            const body = Buffer.isBuffer(request.body)
              ? request.body
              : Buffer.from(JSON.stringify(request.body))
            fs.writeFileSync(filename, body)
            logger.debug(
              `Dumped gRPC request to ${filename} (${body.length} bytes)`
            )
          } catch (e) {
            logger.error(
              `Failed to dump request: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }
      }

      // Log Claude CLI requests
      if (url.includes("/v1/messages")) {
        logger.debug(
          `[Claude CLI] ${request.method} ${url} - Content-Type: ${request.headers["content-type"]}`
        )
      }
    }
  )
}
