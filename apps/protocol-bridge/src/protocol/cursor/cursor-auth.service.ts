import { Injectable, Logger } from "@nestjs/common"
import { DatabaseSync } from "node:sqlite"
import * as path from "path"
import * as os from "os"

/**
 * Service to read and manage Cursor authentication tokens
 */
@Injectable()
export class CursorAuthService {
  private readonly logger = new Logger(CursorAuthService.name)
  private readonly dbPath: string

  constructor() {
    this.dbPath = CursorAuthService.resolveCursorDbPath()
  }

  /**
   * Resolve Cursor state.vscdb path across platforms.
   */
  private static resolveCursorDbPath(): string {
    const home = os.homedir()
    switch (process.platform) {
      case "darwin":
        return path.join(
          home,
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
        )
      case "linux":
        return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb")
      case "win32":
        return path.join(
          process.env.APPDATA || path.join(home, "AppData/Roaming"),
          "Cursor/User/globalStorage/state.vscdb"
        )
      default:
        return path.join(home, ".config/Cursor/User/globalStorage/state.vscdb")
    }
  }

  /**
   * Read Cursor auth tokens from state.vscdb
   */
  getAuthTokens(): {
    accessToken: string | null
    refreshToken: string | null
    email: string | null
    membershipType: string | null
    subscriptionStatus: string | null
  } {
    const result = {
      accessToken: null as string | null,
      refreshToken: null as string | null,
      email: null as string | null,
      membershipType: null as string | null,
      subscriptionStatus: null as string | null,
    }

    try {
      const db = new DatabaseSync(this.dbPath, { readOnly: true })

      const rows = db
        .prepare(
          `SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'`
        )
        .all() as Array<{ key: string; value: string }>

      for (const row of rows) {
        switch (row.key) {
          case "cursorAuth/accessToken":
            result.accessToken = row.value
            break
          case "cursorAuth/refreshToken":
            result.refreshToken = row.value
            break
          case "cursorAuth/cachedEmail":
            result.email = row.value
            break
          case "cursorAuth/stripeMembershipType":
            result.membershipType = row.value
            break
          case "cursorAuth/stripeSubscriptionStatus":
            result.subscriptionStatus = row.value
            break
        }
      }

      db.close()
      this.logger.log(
        `Auth loaded: email=${result.email}, membership=${result.membershipType}`
      )
    } catch (error) {
      this.logger.error("Failed to read auth database", error)
    }

    return result
  }

  /**
   * Decode JWT token to extract user info
   */
  decodeJwt(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split(".")
      if (parts.length !== 3) return null

      const payloadPart = parts[1]
      if (!payloadPart) return null

      const payload = Buffer.from(payloadPart, "base64").toString("utf-8")
      return JSON.parse(payload) as Record<string, unknown>
    } catch (error) {
      this.logger.error("Failed to decode JWT", error)
      return null
    }
  }

  /**
   * Get user ID from access token
   */
  getUserIdFromToken(accessToken: string): string | null {
    const decoded = this.decodeJwt(accessToken)
    if (decoded && typeof decoded.sub === "string") {
      return decoded.sub
    }
    return null
  }
}
