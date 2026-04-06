/**
 * Google OAuth service for Antigravity account authorization.
 *
 * Implements the full OAuth2 flow:
 * 1. Start local HTTP callback server on a random port
 * 2. Generate Google OAuth authorization URL
 * 3. Wait for the callback with the authorization code
 * 4. Exchange code for access_token + refresh_token
 * 5. Fetch user info (email)
 * 6. Save to antigravity-accounts.json
 */

import * as http from "http"
import * as https from "https"
import * as crypto from "crypto"
import * as querystring from "querystring"
import { getAuthBrandLogoHtml } from "./oauth-brand"
import { logger } from "../utils/logger"

// Google OAuth configuration (from Antigravity-Manager)
const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ")

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

interface UserInfo {
  email: string
  name?: string
  picture?: string
}

export interface OAuthResult {
  email: string
  accessToken: string
  refreshToken: string
  expiresAt: string
}

/**
 * Perform a full Google OAuth flow.
 * Returns a promise that resolves with account info after the user completes authorization.
 */
export async function startOAuthFlow(): Promise<{
  authUrl: string
  waitForResult: () => Promise<OAuthResult>
  cancel: () => void
}> {
  const state = crypto.randomBytes(16).toString("hex")
  const server: http.Server | null = null
  let cancelFn: (() => void) | null = null

  // 1. Start local callback server
  const { port, codePromise, cancel } = await startCallbackServer(state)
  cancelFn = cancel

  // 2. Build authorization URL
  const redirectUri = `http://localhost:${port}/callback`
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  })
  const authUrl = `${AUTH_URL}?${params.toString()}`

  logger.info(`OAuth flow started on port ${port}`)

  // 3. Return URL and a function to wait for completion
  const waitForResult = async (): Promise<OAuthResult> => {
    const code = await codePromise

    // 4. Exchange code for tokens
    const tokens = await exchangeCode(code, redirectUri)
    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh_token. " +
          "You may need to revoke access at https://myaccount.google.com/permissions and retry."
      )
    }

    // 5. Get user info
    const userInfo = await getUserInfo(tokens.access_token)

    const expiresAt = new Date(
      Date.now() + tokens.expires_in * 1000
    ).toISOString()

    logger.info(`OAuth completed for ${userInfo.email}`)

    return {
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    }
  }

  return {
    authUrl,
    waitForResult,
    cancel: () => {
      if (cancelFn) cancelFn()
    },
  }
}

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 */
function startCallbackServer(expectedState: string): Promise<{
  port: number
  codePromise: Promise<string>
  cancel: () => void
}> {
  return new Promise((resolve, reject) => {
    const settled = false
    let resolveCode: ((code: string) => void) | null = null
    let rejectCode: ((err: Error) => void) | null = null

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404)
        res.end("Not found")
        return
      }

      const url = new URL(req.url, `http://localhost`)
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getErrorHtml(error))
        if (rejectCode) rejectCode(new Error(`OAuth error: ${error}`))
        server.close()
        return
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getErrorHtml("Invalid state parameter"))
        if (rejectCode) rejectCode(new Error("OAuth state mismatch"))
        server.close()
        return
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(getErrorHtml("No authorization code received"))
        if (rejectCode) rejectCode(new Error("No authorization code received"))
        server.close()
        return
      }

      // Success
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(getSuccessHtml())
      if (resolveCode) resolveCode(code)

      // Close server after a brief delay
      setTimeout(() => server.close(), 1000)
    })

    // Listen on random port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start OAuth callback server"))
        return
      }
      logger.info(`OAuth callback server listening on port ${addr.port}`)
      resolve({
        port: addr.port,
        codePromise,
        cancel: () => {
          if (rejectCode) rejectCode(new Error("OAuth flow cancelled"))
          server.close()
        },
      })
    })

    server.on("error", (err) => {
      reject(err)
    })

    // Auto-close after 5 minutes
    setTimeout(
      () => {
        if (!settled) {
          if (rejectCode) rejectCode(new Error("OAuth flow timed out (5 min)"))
          server.close()
        }
      },
      5 * 60 * 1000
    )
  })
}

/**
 * Exchange authorization code for tokens.
 */
function exchangeCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    })

    const options: https.RequestOptions = {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    }

    const req = https.request(options, (res) => {
      let body = ""
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      res.on("end", () => {
        try {
          const data = JSON.parse(body)
          if (data.error) {
            reject(
              new Error(
                `Token exchange failed: ${data.error_description || data.error}`
              )
            )
          } else {
            resolve(data as TokenResponse)
          }
        } catch {
          reject(new Error(`Invalid token response: ${body}`))
        }
      })
    })

    req.on("error", (err) => {
      reject(new Error(`Token exchange request failed: ${err.message}`))
    })
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error("Token exchange request timed out"))
    })

    req.write(postData)
    req.end()
  })
}

/**
 * Fetch Google user info using an access token.
 */
function getUserInfo(accessToken: string): Promise<UserInfo> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "www.googleapis.com",
      path: "/oauth2/v2/userinfo",
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }

    const req = https.request(options, (res) => {
      let body = ""
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      res.on("end", () => {
        try {
          const data = JSON.parse(body)
          if (data.error) {
            reject(new Error(`UserInfo error: ${JSON.stringify(data.error)}`))
          } else {
            resolve(data as UserInfo)
          }
        } catch {
          reject(new Error(`Invalid userinfo response: ${body}`))
        }
      })
    })

    req.on("error", (err) => {
      reject(new Error(`UserInfo request failed: ${err.message}`))
    })
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error("UserInfo request timed out"))
    })

    req.end()
  })
}

/**
 * Generate success HTML page shown after OAuth callback.
 */
function getSuccessHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorization Successful</title>
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
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Cursor.</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`
}

/**
 * Generate error HTML page.
 */
function getErrorHtml(error: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authorization Failed</title>
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
    <h1>Authorization Failed</h1>
    <p>${error}</p>
  </div>
</body>
</html>`
}
