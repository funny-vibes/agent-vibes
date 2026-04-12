/**
 * Codex OAuth Authentication Service
 *
 * Handles OpenAI OAuth2 PKCE flow for Codex CLI authentication.
 * Supports:
 * - API key authentication (direct)
 * - OAuth access token authentication (from codex CLI login)
 * - Token refresh with retry
 * - JWT ID token parsing for account info
 *
 * Ported from CLIProxyAPI:
 *   - internal/auth/codex/openai_auth.go
 *   - internal/auth/codex/openai.go
 *   - internal/auth/codex/token.go
 *   - internal/auth/codex/jwt_parser.go
 *   - internal/auth/codex/pkce.go
 */

import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  CodexModelTier,
  normalizeCodexModelTier,
} from "../shared/model-registry"

// ── OAuth Constants (matching codex_cli_rs) ────────────────────────────

const AUTH_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const REDIRECT_URI = "http://localhost:1455/auth/callback"

/** Persisted token file path — survives process restarts */
const TOKEN_FILE_PATH = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "agent-vibes-tokens.json"
)

// ── Types ──────────────────────────────────────────────────────────────

export interface PKCECodes {
  codeVerifier: string
  codeChallenge: string
}

export interface CodexTokenData {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId: string
  workspaceId?: string
  email: string
  expire: string
}

export interface CodexAuthBundle {
  apiKey: string
  tokenData: CodexTokenData
  lastRefresh: string
}

interface JWTClaims {
  exp?: number
  sub?: string
  email?: string
  organizations?: Array<{ id: string; is_default?: boolean }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    organizations?: Array<{ id: string; is_default?: boolean }>
  }
  [key: string]: unknown
}

// ── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CodexAuthService {
  private readonly logger = new Logger(CodexAuthService.name)

  /** Current token data (if using OAuth mode) */
  private tokenData: CodexTokenData | null = null
  private lastRefresh: string = ""

  // ── PKCE Utilities ─────────────────────────────────────────────────

  /**
   * Generate PKCE codes for OAuth2 authorization flow.
   * Ported from: internal/auth/codex/pkce.go
   */
  generatePKCECodes(): PKCECodes {
    const verifierBytes = crypto.randomBytes(32)
    const codeVerifier = verifierBytes
      .toString("base64url")
      .replace(/[^a-zA-Z0-9\-._~]/g, "")

    const hash = crypto.createHash("sha256").update(codeVerifier).digest()
    const codeChallenge = hash.toString("base64url")

    return { codeVerifier, codeChallenge }
  }

  // ── Auth URL Generation ────────────────────────────────────────────

  /**
   * Generate the OAuth authorization URL with PKCE.
   * Ported from: internal/auth/codex/openai_auth.go GenerateAuthURL()
   */
  generateAuthURL(state: string, pkceCodes: PKCECodes): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile offline_access",
      state,
      code_challenge: pkceCodes.codeChallenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    })

    return `${AUTH_URL}?${params.toString()}`
  }

  // ── Token Exchange ─────────────────────────────────────────────────

  /**
   * Exchange an authorization code for access and refresh tokens.
   * Ported from: internal/auth/codex/openai_auth.go ExchangeCodeForTokens()
   */
  async exchangeCodeForTokens(
    code: string,
    pkceCodes: PKCECodes,
    redirectUri: string = REDIRECT_URI
  ): Promise<CodexAuthBundle> {
    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: pkceCodes.codeVerifier,
    })

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: data.toString(),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Token exchange failed with status ${response.status}: ${body.slice(0, 200)}`
      )
    }

    const tokenResp = (await response.json()) as {
      access_token: string
      refresh_token: string
      id_token: string
      token_type: string
      expires_in: number
    }

    const claims = this.parseJWTToken(tokenResp.id_token)
    const accountId = claims ? this.extractAccountId(claims) : ""
    const email = claims?.email || ""

    const expireDate = new Date(
      Date.now() + tokenResp.expires_in * 1000
    ).toISOString()

    const tokenData: CodexTokenData = {
      idToken: tokenResp.id_token,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      accountId,
      workspaceId: claims ? this.extractWorkspaceId(claims) : "",
      email,
      expire: expireDate,
    }

    this.tokenData = tokenData
    this.lastRefresh = new Date().toISOString()

    return {
      apiKey: "",
      tokenData,
      lastRefresh: this.lastRefresh,
    }
  }

  // ── Token Refresh ──────────────────────────────────────────────────

  /**
   * Refresh an access token using a refresh token.
   * Ported from: internal/auth/codex/openai_auth.go RefreshTokens()
   */
  async refreshTokens(refreshToken: string): Promise<CodexTokenData> {
    if (!refreshToken) {
      throw new Error("Refresh token is required")
    }

    const data = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    })

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: data.toString(),
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Token refresh failed with status ${response.status}: ${body.slice(0, 200)}`
      )
    }

    const tokenResp = (await response.json()) as {
      access_token: string
      refresh_token: string
      id_token: string
      token_type: string
      expires_in: number
    }

    const claims = this.parseJWTToken(tokenResp.id_token)
    const accountId = claims ? this.extractAccountId(claims) : ""
    const email = claims?.email || ""

    const expireDate = new Date(
      Date.now() + tokenResp.expires_in * 1000
    ).toISOString()

    return {
      idToken: tokenResp.id_token,
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token,
      accountId,
      workspaceId: claims ? this.extractWorkspaceId(claims) : "",
      email,
      expire: expireDate,
    }
  }

  /**
   * Refresh tokens with retry mechanism.
   * Ported from: internal/auth/codex/openai_auth.go RefreshTokensWithRetry()
   */
  async refreshTokensWithRetry(
    refreshToken: string,
    maxRetries: number = 3,
    options?: { persist?: boolean; updateState?: boolean }
  ): Promise<CodexTokenData> {
    let lastError: Error | null = null
    const persist = options?.persist ?? true
    const updateState = options?.updateState ?? true

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }

      try {
        const tokenData = await this.refreshTokens(refreshToken)
        const refreshedAt = new Date().toISOString()
        if (updateState) {
          this.tokenData = tokenData
          this.lastRefresh = refreshedAt
        }
        if (persist) {
          this.persistTokens(
            tokenData,
            updateState ? this.lastRefresh : refreshedAt
          )
        }
        return tokenData
      } catch (e) {
        lastError = e as Error
        const errorMsg = lastError.message.toLowerCase()

        // Non-retryable errors (token rotation violation or revoked)
        if (
          errorMsg.includes("refresh_token_reused") ||
          errorMsg.includes("already been used")
        ) {
          this.logger.warn(
            `Token refresh attempt ${attempt + 1} failed with non-retryable error: ${lastError.message}`
          )
          throw lastError
        }

        this.logger.warn(
          `Token refresh attempt ${attempt + 1} failed: ${lastError.message}`
        )
      }
    }

    throw new Error(
      `Token refresh failed after ${maxRetries} attempts: ${lastError?.message}`
    )
  }

  // ── JWT Parsing ────────────────────────────────────────────────────

  /**
   * Parse a JWT token without verification (for extracting claims).
   * Ported from: internal/auth/codex/jwt_parser.go ParseJWTToken()
   */
  private parseJWTToken(token: string): JWTClaims | null {
    if (!token) return null

    try {
      const parts = token.split(".")
      if (parts.length !== 3) return null

      const payload = parts[1]
      if (!payload) return null

      const decoded = Buffer.from(payload, "base64url").toString("utf-8")
      return JSON.parse(decoded) as JWTClaims
    } catch {
      this.logger.warn("Failed to parse JWT token")
      return null
    }
  }

  /**
   * Extract account ID from JWT claims.
   * Ported from: internal/auth/codex/jwt_parser.go GetAccountID()
   */
  private extractAccountId(claims: JWTClaims): string {
    const authClaims = claims["https://api.openai.com/auth"]
    return authClaims?.chatgpt_account_id?.trim() || ""
  }

  private extractWorkspaceId(claims: JWTClaims): string {
    const candidates = [
      claims["https://api.openai.com/auth"]?.organizations,
      claims.organizations,
    ]

    for (const organizations of candidates) {
      if (!Array.isArray(organizations) || organizations.length === 0) continue

      const defaultOrg = organizations.find(
        (org) => typeof org?.id === "string" && Boolean(org?.is_default)
      )
      if (defaultOrg?.id?.trim()) {
        return defaultOrg.id.trim()
      }

      const firstOrg = organizations.find(
        (org) => typeof org?.id === "string" && org.id.trim().length > 0
      )
      if (firstOrg?.id?.trim()) {
        return firstOrg.id.trim()
      }
    }

    return ""
  }

  // ── Token State ────────────────────────────────────────────────────

  getTokenData(): CodexTokenData | null {
    return this.tokenData
  }

  getTokenExpiryFromJwt(token: string): string | null {
    const claims = this.parseJWTToken(token)
    if (!claims) {
      return null
    }

    const exp = claims.exp
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
      return null
    }

    return new Date(exp * 1000).toISOString()
  }

  isTokenExpired(tokenData: CodexTokenData | null = this.tokenData): boolean {
    if (!tokenData?.expire) return true
    try {
      const expireDate = new Date(tokenData.expire)
      return Date.now() > expireDate.getTime() - 30_000
    } catch {
      return true
    }
  }

  getAccountId(): string {
    return this.tokenData?.accountId || ""
  }

  getAccountIdFromTokenData(tokenData: CodexTokenData | null): string {
    return tokenData?.accountId || ""
  }

  getPlanType(): CodexModelTier | null {
    return this.getPlanTypeFromTokenData(this.tokenData)
  }

  getPlanTypeFromTokenData(
    tokenData: CodexTokenData | null
  ): CodexModelTier | null {
    return this.getPlanTypeFromIdToken(tokenData?.idToken || "")
  }

  getPlanTypeFromIdToken(idToken: string): CodexModelTier | null {
    const claims = this.parseJWTToken(idToken)
    if (!claims) {
      return null
    }

    return normalizeCodexModelTier(
      claims["https://api.openai.com/auth"]?.chatgpt_plan_type
    )
  }

  getAccountIdFromIdToken(idToken: string): string {
    const claims = this.parseJWTToken(idToken)
    if (!claims) {
      return ""
    }

    return this.extractAccountId(claims)
  }

  getWorkspaceIdFromIdToken(idToken: string): string {
    const claims = this.parseJWTToken(idToken)
    if (!claims) {
      return ""
    }

    return this.extractWorkspaceId(claims)
  }

  setTokenData(tokenData: CodexTokenData): void {
    this.tokenData = tokenData
    this.lastRefresh = new Date().toISOString()
  }

  persistTokenData(tokenData: CodexTokenData, lastRefresh?: string): void {
    this.persistTokens(tokenData, lastRefresh || new Date().toISOString())
  }

  /**
   * Ensure we have a valid access token, refreshing if needed.
   */
  async ensureValidToken(): Promise<string | null> {
    if (!this.tokenData) return null

    if (this.isTokenExpired(this.tokenData) && this.tokenData.refreshToken) {
      this.logger.log("Access token expired, refreshing...")
      try {
        await this.refreshTokensWithRetry(this.tokenData.refreshToken)
        this.logger.log("Token refreshed successfully")
      } catch (e) {
        this.logger.error(`Token refresh failed: ${(e as Error).message}`)
        return null
      }
    }

    return this.tokenData.accessToken || null
  }

  // ── Token Persistence ───────────────────────────────────────────────

  /**
   * Persist current token data to disk so it survives process restarts.
   * Ported from: internal/auth/codex/token.go SaveTokenToFile()
   */
  private persistTokens(
    tokenData: CodexTokenData | null = this.tokenData,
    lastRefresh: string = this.lastRefresh
  ): void {
    if (!tokenData) return

    try {
      const dir = path.dirname(TOKEN_FILE_PATH)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

      const payload = {
        type: "codex",
        id_token: tokenData.idToken,
        access_token: tokenData.accessToken,
        refresh_token: tokenData.refreshToken,
        account_id: tokenData.accountId,
        email: tokenData.email,
        expire: tokenData.expire,
        last_refresh: lastRefresh,
      }

      // Atomic write: write to .tmp then rename to prevent partial writes
      const tmpPath = `${TOKEN_FILE_PATH}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
        mode: 0o600,
      })
      fs.renameSync(tmpPath, TOKEN_FILE_PATH)
      this.logger.debug(`Tokens persisted to ${TOKEN_FILE_PATH}`)
    } catch (e) {
      this.logger.warn(`Failed to persist tokens: ${(e as Error).message}`)
    }
  }

  /**
   * Load persisted token data from disk.
   * Returns null if the file does not exist or is malformed.
   */
  loadPersistedTokens(): CodexTokenData | null {
    try {
      if (!fs.existsSync(TOKEN_FILE_PATH)) {
        return null
      }

      const raw = fs.readFileSync(TOKEN_FILE_PATH, "utf8")
      const parsed = JSON.parse(raw) as Record<string, unknown>

      if (parsed.type !== "codex" || !parsed.refresh_token) {
        return null
      }

      const tokenData: CodexTokenData = {
        idToken: (parsed.id_token as string) || "",
        accessToken: (parsed.access_token as string) || "",
        refreshToken: (parsed.refresh_token as string) || "",
        accountId: (parsed.account_id as string) || "",
        email: (parsed.email as string) || "",
        // Support both 'expire' (new) and 'expired' (legacy) field names
        expire: (parsed.expire as string) || (parsed.expired as string) || "",
      }

      this.logger.log(
        `Loaded persisted Codex tokens from ${TOKEN_FILE_PATH} (email=${tokenData.email || "unknown"})`
      )
      return tokenData
    } catch (e) {
      this.logger.warn(
        `Failed to load persisted tokens: ${(e as Error).message}`
      )
      return null
    }
  }
}
