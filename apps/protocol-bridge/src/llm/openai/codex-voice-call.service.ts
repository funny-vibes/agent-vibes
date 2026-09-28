import { Injectable, Logger } from "@nestjs/common"
import type {
  ChatGptWebRealtimeCallRequest,
  ChatGptWebRealtimeCallResult,
} from "./chatgpt-web-realtime"
import { ChatGptWebRealtimeServiceError } from "./chatgpt-web-realtime.service"
import type { CodexVoiceAccountLease } from "./codex-realtime-account"
import {
  buildCodexVoiceSession,
  codexVoiceCallId,
  codexVoiceCallUrl,
} from "./codex-voice-call"
import { CodexService } from "./codex.service"

const CALL_TIMEOUT_MS = 20_000

/**
 * Opens Codex voice calls with the pool's Codex accounts: one account after
 * another until one accepts, refreshing an account's token once when the
 * backend turns it away.
 */
@Injectable()
export class CodexVoiceCallService {
  private readonly logger = new Logger(CodexVoiceCallService.name)

  constructor(private readonly codex: CodexService) {}

  async createCall(
    request: ChatGptWebRealtimeCallRequest
  ): Promise<ChatGptWebRealtimeCallResult> {
    const accountCount = this.codex.getChatGptWebRealtimeAccountCount()
    if (accountCount === 0) {
      throw new ChatGptWebRealtimeServiceError(
        503,
        "realtime_not_configured",
        "No Codex OAuth account is configured for Codex voice"
      )
    }

    const body = JSON.stringify({
      sdp: request.sdp,
      session: buildCodexVoiceSession(request.session),
    })
    const excluded = new Set<string>()
    const failures: string[] = []
    for (let attempt = 0; attempt < accountCount; attempt += 1) {
      const lease = await this.codex.acquireCodexVoiceAccount(excluded)
      if (!lease) break
      excluded.add(lease.accountKey)
      const result = await this.tryCreateCall(body, lease, failures)
      if (result) return result
    }

    if (excluded.size === 0) {
      throw new ChatGptWebRealtimeServiceError(
        503,
        "realtime_temporarily_unavailable",
        "All configured Codex accounts are temporarily unavailable"
      )
    }
    this.logger.warn(
      `Codex voice call failed across ${excluded.size} account(s): ${failures.join(" | ").slice(0, 1_000)}`
    )
    throw new ChatGptWebRealtimeServiceError(
      502,
      "realtime_upstream_unavailable",
      "Codex voice did not accept the call"
    )
  }

  private async tryCreateCall(
    body: string,
    lease: CodexVoiceAccountLease,
    failures: string[]
  ): Promise<ChatGptWebRealtimeCallResult | null> {
    let accessToken = lease.accessToken
    let authRefreshed = false

    while (true) {
      try {
        const init: RequestInit & { dispatcher?: unknown } = {
          method: "POST",
          headers: {
            ...lease.headers(accessToken),
            // The answer is an SDP body; the call id comes in Location.
            Accept: "application/sdp, application/json",
            "OpenAI-Alpha": "quicksilver=v2",
          },
          body,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }
        if (lease.dispatcher) init.dispatcher = lease.dispatcher
        const response = await fetch(codexVoiceCallUrl(lease.callUrl), init)
        const text = await response.text()

        if (response.status === 200 || response.status === 201) {
          const callId = codexVoiceCallId(response.headers.get("location"))
          if (!text.trim().startsWith("v=0") || !callId) {
            lease.reject(502, "Codex voice returned an invalid call response")
            failures.push(`${lease.label}: invalid call response`)
            return null
          }
          lease.accept()
          return { callId, sdp: text, transport: "codex-voice" }
        }

        if (
          !authRefreshed &&
          (response.status === 401 || response.status === 403)
        ) {
          authRefreshed = true
          const refreshed = await lease.refreshAccessToken(
            `Codex voice HTTP ${response.status}`
          )
          if (refreshed) {
            accessToken = refreshed
            continue
          }
        }

        // A malformed session is the caller's to fix, not the account's.
        if (response.status === 400) {
          lease.abandon()
          throw new ChatGptWebRealtimeServiceError(
            400,
            "invalid_session",
            `Codex voice rejected the session: ${detail(text)}`
          )
        }

        lease.reject(response.status || 502, detail(text))
        failures.push(`${lease.label}: HTTP ${response.status} ${detail(text)}`)
        return null
      } catch (error) {
        if (error instanceof ChatGptWebRealtimeServiceError) throw error
        const message = error instanceof Error ? error.message : String(error)
        lease.reject(502, message)
        failures.push(`${lease.label}: ${message}`)
        return null
      }
    }
  }
}

function detail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "empty response"
}
