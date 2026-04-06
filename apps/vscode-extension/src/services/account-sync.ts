import * as fs from "fs"
import * as https from "https"
import { ConfigManager } from "./config-manager"
import type { logger as LoggerInstance } from "../utils/logger"

type Logger = typeof LoggerInstance

export interface AntigravityIdeSyncResult {
  synced: boolean
  email: string
  name: string | null
  path: string
  accountCount: number
}

/**
 * AccountSyncService - delegates Antigravity IDE credential sync to the local
 * bridge process, which owns the SQLite parsing and account-file writes.
 */
export class AccountSyncService {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  async syncToBridge(config: ConfigManager): Promise<AntigravityIdeSyncResult> {
    const caPath = config.caCertPath
    const caData = fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined

    const body = await new Promise<string>((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: "localhost",
        port: config.port,
        path: "/api/antigravity/sync-ide",
        method: "POST",
        ca: caData,
        rejectUnauthorized: !!caData,
        timeout: 10000,
        headers: {
          "Content-Length": "0",
        },
      }

      const req = https.request(options, (res) => {
        let responseBody = ""
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on("end", () => {
          const statusCode = res.statusCode ?? 500
          if (statusCode >= 400) {
            reject(
              new Error(
                this.formatBridgeError(
                  statusCode,
                  res.statusMessage,
                  responseBody
                )
              )
            )
            return
          }
          resolve(responseBody)
        })
      })

      req.on("error", (error) => reject(error))
      req.setTimeout(10000, () => {
        req.destroy(new Error("Bridge sync request timed out"))
      })
      req.end()
    })

    const parsed = JSON.parse(body) as Partial<AntigravityIdeSyncResult>
    if (
      parsed.synced !== true ||
      typeof parsed.email !== "string" ||
      typeof parsed.path !== "string"
    ) {
      throw new Error("Bridge returned an invalid Antigravity sync response")
    }

    this.logger.info(
      `Antigravity IDE credentials synced for ${parsed.email} -> ${parsed.path}`
    )

    return {
      synced: true,
      email: parsed.email,
      name: typeof parsed.name === "string" ? parsed.name : null,
      path: parsed.path,
      accountCount:
        typeof parsed.accountCount === "number" ? parsed.accountCount : 0,
    }
  }

  private formatBridgeError(
    statusCode: number,
    statusMessage: string | undefined,
    responseBody: string
  ): string {
    try {
      const parsed = JSON.parse(responseBody) as {
        message?: string | string[]
        error?: string
      }

      if (Array.isArray(parsed.message) && parsed.message.length > 0) {
        return `Bridge sync failed (${statusCode}): ${parsed.message.join(", ")}`
      }

      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return `Bridge sync failed (${statusCode}): ${parsed.message.trim()}`
      }

      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return `Bridge sync failed (${statusCode}): ${parsed.error.trim()}`
      }
    } catch {
      // fall through
    }

    const fallback = responseBody.trim() || statusMessage || "Unknown error"
    return `Bridge sync failed (${statusCode}): ${fallback}`
  }
}
