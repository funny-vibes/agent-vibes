/**
 * Codex (OpenAI) OAuth service for account authorization.
 *
 * Implements the full OAuth2 PKCE flow:
 * 1. Generate PKCE codes (code_verifier + code_challenge)
 * 2. Start local HTTP callback server on port 1455
 * 3. Generate OpenAI authorization URL
 * 4. Wait for the callback with the authorization code
 * 5. Exchange code for access_token + refresh_token + id_token
 * 6. Parse JWT id_token for email + accountId + planType
 *
 * Ported from CLIProxyAPI:
 *   - internal/auth/codex/openai_auth.go
 *   - internal/auth/codex/pkce.go
 *   - internal/auth/codex/jwt_parser.go
 */

import * as http from "http"
import * as crypto from "crypto"
import { getAuthBrandLogoHtml } from "./oauth-brand"
import { logger } from "../utils/logger"

// ── OAuth Constants (matching codex_cli_rs + CLIProxyAPI) ─────────────

const AUTH_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CALLBACK_PORT = 1455
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`

// ── Types ─────────────────────────────────────────────────────────────

interface PKCECodes {
  codeVerifier: string
  codeChallenge: string
}

interface CodexTokenResponse {
  access_token: string
  refresh_token: string
  id_token: string
  token_type: string
  expires_in: number
}

interface CodexOrganizationClaim {
  id?: string
  is_default?: boolean
}

interface CodexJWTClaims {
  email?: string
  exp?: number
  organizations?: CodexOrganizationClaim[]
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_plan_type?: string
    organizations?: CodexOrganizationClaim[]
  }
  [key: string]: unknown
}

export interface CodexOAuthResult {
  email: string
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  workspaceId: string
  planType: string
  expire: string
}

// ── PKCE ──────────────────────────────────────────────────────────────

function generatePKCECodes(): PKCECodes {
  // Generate 96 random bytes → 128-char base64url verifier (matches Go impl)
  const verifierBytes = crypto.randomBytes(96)
  const codeVerifier = verifierBytes.toString("base64url")

  const hash = crypto.createHash("sha256").update(codeVerifier).digest()
  const codeChallenge = hash.toString("base64url")

  return { codeVerifier, codeChallenge }
}

// ── JWT Parsing ───────────────────────────────────────────────────────

function parseJWTToken(token: string): CodexJWTClaims | null {
  if (!token) return null

  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null

    const payload = parts[1]
    if (!payload) return null

    const decoded = Buffer.from(payload, "base64url").toString("utf-8")
    return JSON.parse(decoded) as CodexJWTClaims
  } catch {
    return null
  }
}

function extractDefaultWorkspaceId(claims: CodexJWTClaims | null): string {
  if (!claims) return ""

  const candidates = [
    claims["https://api.openai.com/auth"]?.organizations,
    claims.organizations,
  ]

  for (const organizations of candidates) {
    if (!Array.isArray(organizations) || organizations.length === 0) continue

    const defaultOrg = organizations.find(
      (org) => org && typeof org.id === "string" && org.is_default
    )
    if (defaultOrg?.id) return defaultOrg.id.trim()

    const firstOrg = organizations.find(
      (org) => org && typeof org.id === "string" && org.id.trim().length > 0
    )
    if (firstOrg?.id) return firstOrg.id.trim()
  }

  return ""
}

// ── Active Flow Tracking ──────────────────────────────────────────────

/** Track the active callback server so we can clean it up on retry. */
let activeCancel: (() => void) | null = null

// ── Main OAuth Flow ───────────────────────────────────────────────────

/**
 * Perform a full Codex OAuth2 PKCE flow.
 * Returns a promise that resolves with account info after the user completes authorization.
 */
export async function startCodexOAuthFlow(): Promise<{
  authUrl: string
  waitForResult: () => Promise<CodexOAuthResult>
  cancel: () => void
}> {
  // Clean up any previous flow (e.g. timed-out or cancelled) so the port is freed
  if (activeCancel) {
    try {
      activeCancel()
    } catch {
      // ignore cleanup errors
    }
    activeCancel = null
  }

  const state = crypto.randomBytes(16).toString("hex")
  const pkceCodes = generatePKCECodes()

  // 1. Start local callback server
  const { codePromise, cancel } = await startCodexCallbackServer(state)
  activeCancel = cancel

  // 2. Build authorization URL
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
  const authUrl = `${AUTH_URL}?${params.toString()}`

  logger.info(`Codex OAuth flow started on port ${CALLBACK_PORT}`)

  // 3. Return URL and wait function
  const waitForResult = async (): Promise<CodexOAuthResult> => {
    let code: string
    try {
      code = await codePromise
    } finally {
      // Flow finished (success, error, or timeout) — clear tracked reference
      activeCancel = null
    }

    // 4. Exchange code for tokens
    const tokens = await exchangeCodexCode(code, pkceCodes)

    // 5. Parse JWT for user info
    const claims = parseJWTToken(tokens.id_token)
    const authClaims = claims?.["https://api.openai.com/auth"]

    const email = claims?.email || ""
    const accountId = authClaims?.chatgpt_account_id || ""
    const workspaceId = extractDefaultWorkspaceId(claims)
    const planType = authClaims?.chatgpt_plan_type || ""
    const expire = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    logger.info(`Codex OAuth completed for ${email || "unknown"} (${planType})`)

    return {
      email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      accountId,
      workspaceId,
      planType,
      expire,
    }
  }

  return {
    authUrl,
    waitForResult,
    cancel,
  }
}

// ── Callback Server ───────────────────────────────────────────────────

function startCodexCallbackServer(expectedState: string): Promise<{
  codePromise: Promise<string>
  cancel: () => void
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: ((code: string) => void) | null = null
    let rejectCode: ((err: Error) => void) | null = null

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/auth/callback")) {
        res.writeHead(404)
        res.end("Not found")
        return
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getCodexErrorHtml(error))
        if (rejectCode) rejectCode(new Error(`Codex OAuth error: ${error}`))
        server.close()
        return
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getCodexErrorHtml("Invalid state parameter"))
        if (rejectCode) rejectCode(new Error("Codex OAuth state mismatch"))
        server.close()
        return
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getCodexErrorHtml("No authorization code received"))
        if (rejectCode) rejectCode(new Error("No authorization code received"))
        server.close()
        return
      }

      // Success
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(getCodexSuccessHtml())
      if (resolveCode) resolveCode(code)

      setTimeout(() => server.close(), 1000)
    })

    // Listen on fixed Codex callback port
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      logger.info(
        `Codex OAuth callback server listening on port ${CALLBACK_PORT}`
      )
      resolve({
        codePromise,
        cancel: () => {
          if (rejectCode) rejectCode(new Error("Codex OAuth flow cancelled"))
          server.close()
        },
      })
    })

    server.on("error", (err) => {
      reject(
        new Error(
          `Failed to start Codex callback server on port ${CALLBACK_PORT}: ${err.message}. ` +
            `Make sure no other process is using this port.`
        )
      )
    })

    // Auto-close after 5 minutes
    setTimeout(
      () => {
        if (rejectCode)
          rejectCode(new Error("Codex OAuth flow timed out (5 min)"))
        server.close()
      },
      5 * 60 * 1000
    )
  })
}

// ── Token Exchange ────────────────────────────────────────────────────

async function exchangeCodexCode(
  code: string,
  pkceCodes: PKCECodes
): Promise<CodexTokenResponse> {
  const data = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
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
      `Codex token exchange failed with status ${response.status}: ${body.slice(0, 200)}`
    )
  }

  return (await response.json()) as CodexTokenResponse
}

// ── HTML Pages ────────────────────────────────────────────────────────

function getCodexSuccessHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authentication Successful - Codex</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
    background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 48px; }
  .logo { width: 72px; height: 72px; margin-bottom: 20px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #8b949e; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    ${getAuthBrandLogoHtml()}
    <h1>Codex Authorization Successful</h1>
    <p>You can close this window and return to your editor.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`
}

function getCodexErrorHtml(error: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authentication Failed - Codex</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
    background: #0d1117; color: #e6edf3; }
  .card { text-align: center; padding: 48px; }
  .logo { width: 72px; height: 72px; margin-bottom: 20px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #f85149; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    ${getAuthBrandLogoHtml()}
    <h1>Codex Authorization Failed</h1>
    <p>${error}</p>
  </div>
</body>
</html>`
}
