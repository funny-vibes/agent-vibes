import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import { DatabaseSync } from "node:sqlite"
import * as fs from "fs"
import * as path from "path"
import type { NativeAccount } from "../../llm/google/process-pool.service"
import {
  resolveAntigravityIdeStateDbPath,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"

type AntigravityUserStatus = {
  email: string
  name: string | null
}

type AntigravityAccountFile = {
  accounts?: NativeAccount[]
  quotaFallbackModel?: string
}

@Injectable()
export class AntigravityIdeSyncService {
  private readonly logger = new Logger(AntigravityIdeSyncService.name)

  syncCredentialsFromIde(): {
    email: string
    name: string | null
    path: string
    accountCount: number
  } {
    const dbPath = this.resolveStateDbPath()
    if (!fs.existsSync(dbPath)) {
      throw new BadRequestException(
        `Antigravity IDE state.vscdb not found: ${dbPath}`
      )
    }

    const db = new DatabaseSync(dbPath, { readOnly: true })
    let userStatusB64 = ""
    let oauthB64 = ""
    let enterprisePreferencesB64 = ""

    try {
      const userStatusRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("antigravityUnifiedStateSync.userStatus") as unknown as
        | { value?: string }
        | undefined
      userStatusB64 =
        userStatusRow && typeof userStatusRow.value === "string"
          ? userStatusRow.value.trim()
          : ""

      const oauthRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("antigravityUnifiedStateSync.oauthToken") as
        | { value?: string }
        | undefined
      oauthB64 =
        oauthRow && typeof oauthRow.value === "string"
          ? oauthRow.value.trim()
          : ""

      const enterprisePreferencesRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("antigravityUnifiedStateSync.enterprisePreferences") as
        | { value?: string }
        | undefined
      enterprisePreferencesB64 =
        enterprisePreferencesRow &&
        typeof enterprisePreferencesRow.value === "string"
          ? enterprisePreferencesRow.value.trim()
          : ""
    } finally {
      db.close()
    }

    if (!userStatusB64) {
      throw new BadRequestException(
        "Not logged in to Antigravity IDE: missing antigravityUnifiedStateSync.userStatus"
      )
    }

    const userStatus = this.extractUserStatus(userStatusB64)

    if (!oauthB64) {
      throw new BadRequestException(
        "Antigravity IDE OAuth token not found in state.vscdb"
      )
    }

    const tokens = this.extractTokens(oauthB64)
    const quotaProjectId = this.extractEnterpriseGcpProjectId(
      enterprisePreferencesB64
    )
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new BadRequestException(
        "Could not extract Antigravity IDE OAuth tokens from state.vscdb"
      )
    }

    const destinationPath = resolveDefaultAccountConfigPath(
      "antigravity-accounts.json"
    )
    const existing = this.readExistingAccountFile(destinationPath)
    const preserved = this.findMatchingAccount(
      existing?.accounts,
      userStatus.email,
      tokens.refreshToken
    )
    const payload: AntigravityAccountFile = {
      accounts: [
        {
          email: userStatus.email,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          quotaProjectId,
          isGcpTos: false,
          ...(preserved?.projectId ? { projectId: preserved.projectId } : {}),
          ...(preserved?.proxyUrl ? { proxyUrl: preserved.proxyUrl } : {}),
          ...(preserved?.cloudCodeUrlOverride
            ? { cloudCodeUrlOverride: preserved.cloudCodeUrlOverride }
            : {}),
        },
      ],
    }

    if (existing?.quotaFallbackModel?.trim()) {
      payload.quotaFallbackModel = existing.quotaFallbackModel.trim()
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
    fs.writeFileSync(destinationPath, JSON.stringify(payload, null, 2), "utf8")

    this.logger.log(
      `Synced Antigravity IDE account for ${userStatus.email} -> ${destinationPath}`
    )

    return {
      email: userStatus.email,
      name: userStatus.name,
      path: destinationPath,
      accountCount: payload.accounts?.length || 0,
    }
  }

  private readExistingAccountFile(
    filePath: string
  ): AntigravityAccountFile | null {
    if (!fs.existsSync(filePath)) {
      return null
    }

    try {
      return JSON.parse(
        fs.readFileSync(filePath, "utf8")
      ) as AntigravityAccountFile
    } catch {
      this.logger.warn(
        `Failed to parse existing Antigravity account file: ${filePath}`
      )
      return null
    }
  }

  private findMatchingAccount(
    accounts: NativeAccount[] | undefined,
    email: string,
    refreshToken: string
  ): NativeAccount | undefined {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return undefined
    }

    const normalizedEmail = email.trim().toLowerCase()
    const normalizedRefreshToken = refreshToken.trim()

    return accounts.find((account) => {
      const accountEmail =
        typeof account.email === "string"
          ? account.email.trim().toLowerCase()
          : ""
      const accountRefreshToken =
        typeof account.refreshToken === "string"
          ? account.refreshToken.trim()
          : ""
      return (
        (normalizedEmail && accountEmail === normalizedEmail) ||
        (normalizedRefreshToken &&
          accountRefreshToken === normalizedRefreshToken)
      )
    })
  }

  private extractUserStatus(encodedValue: string): AntigravityUserStatus {
    let decoded = ""
    try {
      decoded = Buffer.from(encodedValue, "base64").toString("utf8")
    } catch {
      throw new BadRequestException(
        "Invalid Antigravity IDE user status payload"
      )
    }

    const blocks = decoded.match(/[A-Za-z0-9+/=]{20,}/g) || []
    for (const block of blocks) {
      let candidate = ""
      try {
        candidate = Buffer.from(block, "base64").toString("utf8")
      } catch {
        continue
      }

      const emailMatch = candidate.match(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
      )
      if (!emailMatch?.[0]) {
        continue
      }

      const email = emailMatch[0].trim().toLowerCase()
      const prefix = candidate.slice(0, emailMatch.index ?? 0)
      const nameParts = prefix
        .split(":")
        .map((value) => value.trim())
        .filter(Boolean)
      const rawName = nameParts[nameParts.length - 1]
      const sanitizedName = rawName
        ? rawName.replace(/[^\p{L}\p{N} ._'’-]/gu, "").trim()
        : ""

      return {
        email,
        name: sanitizedName || null,
      }
    }

    throw new BadRequestException(
      "Invalid Antigravity IDE user status payload: missing email"
    )
  }

  private extractTokens(oauthB64: string): {
    accessToken: string | null
    refreshToken: string | null
  } {
    const text = Buffer.from(oauthB64, "base64").toString("utf8")
    const blocks = text.match(/[A-Za-z0-9+/=]{50,}/g) || []
    let accessToken: string | null = null
    let refreshToken: string | null = null

    for (const block of blocks) {
      let decoded = ""
      try {
        decoded = Buffer.from(block, "base64").toString("utf8")
      } catch {
        continue
      }

      if (!accessToken) {
        const match = decoded.match(/(ya29\.[A-Za-z0-9_\-/+=]+)/)
        if (match?.[1]) {
          accessToken = match[1]
        }
      }

      if (!refreshToken) {
        const match = decoded.match(/(1\/\/[A-Za-z0-9_\-/+=]+)/)
        if (match?.[1]) {
          refreshToken = match[1]
        }
      }

      if (accessToken && refreshToken) {
        break
      }
    }

    return { accessToken, refreshToken }
  }

  private extractEnterpriseGcpProjectId(
    encodedValue: string | null | undefined
  ): string | undefined {
    if (!encodedValue?.trim()) return undefined

    try {
      const decoded = Buffer.from(encodedValue.trim(), "base64").toString(
        "utf8"
      )
      if (!decoded.includes("enterpriseGcpProjectId")) {
        return undefined
      }

      const candidates = [
        decoded,
        ...(decoded.match(/[A-Za-z0-9+/=]{4,}/g) || []).map((value) => {
          try {
            return Buffer.from(value, "base64").toString("utf8")
          } catch {
            return ""
          }
        }),
      ]

      for (const candidate of candidates) {
        const matches = candidate.match(/\b[a-z][a-z0-9-]{4,}\b/g) || []
        for (const match of matches) {
          if (match !== "enterpriseGcpProjectId") {
            return match
          }
        }
      }
    } catch {
      return undefined
    }

    return undefined
  }

  private resolveStateDbPath(): string {
    return resolveAntigravityIdeStateDbPath()
  }
}
